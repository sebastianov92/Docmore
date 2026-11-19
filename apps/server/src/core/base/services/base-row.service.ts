// TODO(formula): when bulk create/update is added, consult FormulaService.inlineThreshold
// and enqueue a BASE_FORMULA_RECOMPUTE job with reason: "bulk_import" for the
// affected row IDs when above threshold; inline-eval below.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseViewRepo } from '@docmost/db/repos/base/base-view.repo';
import { CreateRowDto } from '../dto/create-row.dto';
import {
  UpdateRowDto,
  DeleteRowDto,
  DeleteRowsDto,
  ListRowsDto,
  ReorderRowDto,
  CountRowsDto,
} from '../dto/update-row.dto';
import {
  BasePropertyTypeValue,
  validateCellValue,
  isSystemPropertyType,
  BasePropertyType,
} from '../base.schemas';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { BaseProperty, BaseRow } from '@docmost/db/types/entity.types';
import {
  Condition,
  FilterNode,
  PropertySchema,
  SearchSpec,
  filterGroupSchema,
  searchSchema,
  validateFilterTree,
} from '../engine';
import { EventName } from '../../../common/events/event.contants';
import {
  BaseRowCreatedEvent,
  BaseRowDeletedEvent,
  BaseRowReorderedEvent,
  BaseRowUpdatedEvent,
  BaseRowsDeletedEvent,
} from '../events/base-events';
import { FormulaService } from '../formula/formula.service';
import { BaseRelationService } from './base-relation.service';
import { BaseHistoryService } from './base-history.service';
import { BaseVisibilityService } from './base-visibility.service';

// Cap for `count({ exact: true })`. Beyond this we return `capped: true` and
// the UI shows "N+". Chosen so a cell-wise scan stays well under 100ms on
// the existing `idx_base_rows_cells_gin_path_ops` index; callers that need
// true totals should fall back to `exact: false` (planner estimate).
const EXACT_COUNT_CAP = 10_000;

@Injectable()
export class BaseRowService {
  constructor(
    private readonly history: BaseHistoryService,
    private readonly visibility: BaseVisibilityService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly baseRowRepo: BaseRowRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseViewRepo: BaseViewRepo,
    private readonly eventEmitter: EventEmitter2,
    private readonly formulaService: FormulaService,
    private readonly relationService: BaseRelationService,
  ) {}

  async create(
    userId: string | null,
    workspaceId: string,
    dto: CreateRowDto,
    opts: { hidden?: Set<string>; automationDepth?: number; formId?: string | null } = {},
  ) {
    this.visibility.assertWritable(dto.cells ?? {}, opts.hidden);
    let position: string;

    if (dto.afterRowId) {
      const afterRow = await this.baseRowRepo.findById(dto.afterRowId, {
        workspaceId,
      });
      if (!afterRow || afterRow.pageId !== dto.pageId) {
        throw new BadRequestException('Invalid afterRowId');
      }
      position = generateJitteredKeyBetween(afterRow.position, null);
    } else {
      const lastPosition = await this.baseRowRepo.getLastPosition(dto.pageId, {
        workspaceId,
      });
      position = generateJitteredKeyBetween(lastPosition, null);
    }

    const properties = await this.basePropertyRepo.findByPageId(dto.pageId);

    // A template seeds the new row; the caller's cells win over it.
    let seed: Record<string, unknown> = {};
    if (dto.fromTemplateId) {
      const template = await this.baseRowRepo.findById(dto.fromTemplateId, {
        workspaceId,
      });
      if (!template || template.pageId !== dto.pageId || !template.isTemplate) {
        throw new BadRequestException('Invalid fromTemplateId');
      }
      seed = { ...((template.cells as Record<string, unknown>) ?? {}) };
      for (const p of properties) {
        if (p.type === 'formula') delete seed[p.id];
      }
    }

    let validatedCells: Record<string, unknown> = {};
    const incoming = { ...seed, ...(dto.cells ?? {}) };
    if (Object.keys(incoming).length > 0) {
      validatedCells = this.validateCells(incoming, properties);
      await this.relationService.assertTargets(validatedCells, properties, workspaceId);
    }

    // On create, treat every user-provided cell plus every formula property
    // as dirty. The formula patch is merged into the cells we persist.
    const dirtyProps = Object.keys(validatedCells);
    const formulaPatch = this.formulaService.evaluateInline({
      properties,
      row: validatedCells,
      dirtyProps: [
        ...dirtyProps,
        ...properties.filter((p) => p.type === 'formula').map((p) => p.id),
      ],
    });
    const finalCells = { ...validatedCells, ...formulaPatch };

    const hierarchy = await this.checkHierarchy(dto.pageId, workspaceId, null, dto.parentRowId, dto.blockedBy);

    const created = await this.baseRowRepo.insertRow({
      pageId: dto.pageId,
      cells: finalCells as any,
      position,
      creatorId: userId,
      workspaceId,
      isTemplate: dto.isTemplate === true,
      parentRowId: hierarchy.parentRowId ?? null,
      blockedBy: (hierarchy.blockedBy ?? []) as any,
    });

    const event: BaseRowCreatedEvent = {
      pageId: dto.pageId,
      workspaceId,
      actorId: userId,
      requestId: dto.requestId ?? null,
      row: created,
      automationDepth: opts.automationDepth,
      formId: opts.formId ?? null,
    };
    this.eventEmitter.emit(EventName.BASE_ROW_CREATED, event);

    return created;
  }

  async getRowInfo(
    rowId: string,
    pageId: string,
    workspaceId: string,
    opts: { hidden?: Set<string> } = {},
  ) {
    const row = await this.baseRowRepo.findById(rowId, { workspaceId });
    if (!row || row.pageId !== pageId) {
      throw new NotFoundException('Row not found');
    }
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    const related = await this.relationService.loadRelated([row], properties, workspaceId);
    await this.relationService.applyRollups([row], properties, related.byId);
    this.visibility.stripRows([row], opts.hidden);
    return row;
  }

  async update(
    dto: UpdateRowDto,
    workspaceId: string,
    userId?: string | null,
    opts: { hidden?: Set<string>; automationDepth?: number } = {},
  ) {
    this.visibility.assertWritable(dto.cells ?? {}, opts.hidden);
    const properties = await this.basePropertyRepo.findByPageId(dto.pageId);
    const validatedCells = this.validateCells(dto.cells ?? {}, properties);
    await this.relationService.assertTargets(validatedCells, properties, workspaceId);
    const hierarchy = await this.checkHierarchy(
      dto.pageId,
      workspaceId,
      dto.rowId,
      dto.parentRowId,
      dto.blockedBy,
    );

    // Smoke-check the position (same guard as `reorder`).
    if (dto.position !== undefined) {
      try {
        generateJitteredKeyBetween(dto.position, null);
      } catch {
        throw new BadRequestException('Invalid position value');
      }
    }

    const existing = await this.baseRowRepo.findById(dto.rowId, { workspaceId });
    if (existing) await this.history.recordUpdate(existing, validatedCells, userId);
    const mergedRow = {
      ...((existing?.cells as Record<string, unknown>) ?? {}),
      ...validatedCells,
    };
    const formulaPatch = this.formulaService.evaluateInline({
      properties,
      row: mergedRow,
      dirtyProps: Object.keys(validatedCells),
    });
    const finalCells = { ...validatedCells, ...formulaPatch };

    const updated = await this.baseRowRepo.updateCells(
      dto.rowId,
      finalCells,
      {
        pageId: dto.pageId,
        workspaceId,
        actorId: userId,
        position: dto.position,
        parentRowId: hierarchy.parentRowId,
        blockedBy: hierarchy.blockedBy,
      },
    );

    if (!updated) {
      throw new NotFoundException('Row not found');
    }

    const event: BaseRowUpdatedEvent = {
      pageId: dto.pageId,
      workspaceId,
      actorId: userId ?? null,
      requestId: dto.requestId ?? null,
      rowId: dto.rowId,
      patch: dto.cells,
      updatedCells: finalCells,
      automationDepth: opts.automationDepth,
    };
    this.eventEmitter.emit(EventName.BASE_ROW_UPDATED, event);

    return updated;
  }

  async delete(dto: DeleteRowDto, workspaceId: string, userId?: string) {
    const row = await this.baseRowRepo.findById(dto.rowId, { workspaceId });
    if (!row || row.pageId !== dto.pageId) {
      throw new NotFoundException('Row not found');
    }

    await this.history.recordDelete([row], userId);
    await this.baseRowRepo.softDelete(dto.rowId, {
      pageId: dto.pageId,
      workspaceId,
    });

    const event: BaseRowDeletedEvent = {
      pageId: dto.pageId,
      workspaceId,
      actorId: userId ?? null,
      requestId: dto.requestId ?? null,
      rowId: dto.rowId,
    };
    this.eventEmitter.emit(EventName.BASE_ROW_DELETED, event);
  }

  async deleteMany(
    dto: DeleteRowsDto,
    workspaceId: string,
    userId?: string,
  ): Promise<void> {
    const rows = await this.baseRowRepo.findByIds(dto.rowIds, { workspaceId });
    if (rows.length !== dto.rowIds.length) {
      throw new NotFoundException('One or more rows not found');
    }
    if (rows.some((r) => r.pageId !== dto.pageId)) {
      throw new NotFoundException('Row does not belong to base');
    }

    await this.history.recordDelete(rows, userId);
    await this.baseRowRepo.softDeleteMany(dto.rowIds, {
      pageId: dto.pageId,
      workspaceId,
    });

    const event: BaseRowsDeletedEvent = {
      pageId: dto.pageId,
      workspaceId,
      actorId: userId ?? null,
      requestId: dto.requestId ?? null,
      rowIds: dto.rowIds,
    };
    this.eventEmitter.emit(EventName.BASE_ROWS_DELETED, event);
  }

  async list(
    dto: ListRowsDto,
    pagination: PaginationOptions,
    workspaceId: string,
    opts: { hidden?: Set<string> } = {},
  ) {
    const properties = await this.basePropertyRepo.findByPageId(dto.pageId);
    const schema: PropertySchema = new Map(
      properties.map((p) => [p.id, p]),
    );

    const hidden = opts.hidden;
    const filter = this.visibility.stripFilter(this.normaliseFilter(dto), hidden);
    const search = this.visibility.stripSearch(this.normaliseSearch(dto.search), hidden);
    const sorts = dto.sorts
      ?.filter((s) => !hidden?.has(s.propertyId))
      .map((s) => ({
        propertyId: s.propertyId,
        direction: s.direction,
      }));

    const result = await this.baseRowRepo.list({
      pageId: dto.pageId,
      workspaceId,
      filter,
      sorts,
      search,
      schema,
      pagination,
      templates: dto.templates === true,
    });
    const related = await this.relationService.loadRelated(
      result.items as BaseRow[],
      properties,
      workspaceId,
    );
    await this.relationService.applyRollups(result.items as BaseRow[], properties, related.byId);
    const references = await this.collectReferences(
      result.items as BaseRow[],
      properties,
      workspaceId,
    );
    this.visibility.stripRows(result.items as BaseRow[], hidden);
    return { ...result, references: { ...references, rows: related.refs } };
  }

  // Parent and dependencies must be live rows of the same base; a row can't
  // be its own ancestor.
  private async checkHierarchy(
    pageId: string,
    workspaceId: string,
    rowId: string | null,
    parentRowId: string | null | undefined,
    blockedBy: string[] | null | undefined,
  ): Promise<{ parentRowId?: string | null; blockedBy?: string[] | null }> {
    const out: { parentRowId?: string | null; blockedBy?: string[] | null } = {};
    if (parentRowId !== undefined) {
      if (parentRowId === null) out.parentRowId = null;
      else {
        if (parentRowId === rowId) throw new BadRequestException('A row cannot be its own parent');
        let cursor: string | null = parentRowId;
        for (let depth = 0; cursor && depth < 50; depth++) {
          const parent = await this.baseRowRepo.findById(cursor, { workspaceId });
          if (!parent || parent.pageId !== pageId) throw new BadRequestException('Parent row not found in this base');
          if (parent.id === rowId) throw new BadRequestException('That would make a loop of sub-items');
          cursor = parent.parentRowId ?? null;
        }
        out.parentRowId = parentRowId;
      }
    }
    if (blockedBy !== undefined) {
      if (blockedBy === null || blockedBy.length === 0) out.blockedBy = [];
      else {
        const ids = [...new Set(blockedBy)].filter((id) => id !== rowId);
        const found = await this.baseRowRepo.findByIds(ids, { workspaceId });
        const ok = new Set(found.filter((r) => r.pageId === pageId).map((r) => r.id));
        if (ids.some((id) => !ok.has(id))) throw new BadRequestException('Dependency rows not found in this base');
        out.blockedBy = ids;
      }
    }
    return out;
  }

  // Names behind the ids in a page of rows, so readers (public ones have
  // no member list) can show people and linked pages.
  private async collectReferences(
    rows: BaseRow[],
    properties: BaseProperty[],
    workspaceId: string,
  ) {
    const personIds = new Set(
      properties
        .filter((p) => p.type === BasePropertyType.PERSON)
        .map((p) => p.id),
    );
    const pageIds = new Set(
      properties
        .filter((p) => p.type === BasePropertyType.PAGE)
        .map((p) => p.id),
    );
    const userIds = new Set<string>();
    const linkedPageIds = new Set<string>();
    for (const row of rows) {
      if (row.creatorId) userIds.add(row.creatorId);
      if (row.lastUpdatedById) userIds.add(row.lastUpdatedById);
      const cells = (row.cells ?? {}) as Record<string, unknown>;
      for (const [propertyId, value] of Object.entries(cells)) {
        if (personIds.has(propertyId)) {
          for (const id of Array.isArray(value) ? value : [value]) {
            if (typeof id === 'string') userIds.add(id);
          }
        } else if (pageIds.has(propertyId) && typeof value === 'string') {
          linkedPageIds.add(value);
        }
      }
    }
    const users: Record<string, { id: string; name: string | null; avatarUrl: string | null }> = {};
    if (userIds.size > 0) {
      const found = await this.db
        .selectFrom('users')
        .select(['id', 'name', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('id', 'in', [...userIds])
        .execute();
      for (const u of found) users[u.id] = { id: u.id, name: u.name, avatarUrl: u.avatarUrl };
    }
    const pages: Record<string, { id: string; slugId: string; title: string | null; icon: string | null; spaceId: string; space: { id: string; slug: string; name: string } | null }> = {};
    if (linkedPageIds.size > 0) {
      const found = await this.db
        .selectFrom('pages')
        .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
        .select(['pages.id', 'pages.slugId', 'pages.title', 'pages.icon', 'pages.spaceId', 'spaces.slug as spaceSlug', 'spaces.name as spaceName'])
        .where('pages.workspaceId', '=', workspaceId)
        .where('pages.deletedAt', 'is', null)
        .where('pages.id', 'in', [...linkedPageIds])
        .execute();
      for (const pg of found) {
        pages[pg.id] = {
          id: pg.id,
          slugId: pg.slugId,
          title: pg.title,
          icon: pg.icon,
          spaceId: pg.spaceId,
          space: { id: pg.spaceId, slug: pg.spaceSlug, name: pg.spaceName },
        };
      }
    }
    return { users, pages };
  }

  async count(dto: CountRowsDto, workspaceId: string, opts: { hidden?: Set<string> } = {}) {
    const properties = await this.basePropertyRepo.findByPageId(dto.pageId);
    const schema: PropertySchema = new Map(properties.map((p) => [p.id, p]));

    const filter = this.visibility.stripFilter(this.normaliseFilter({ filter: dto.filter }), opts.hidden);
    const search = this.visibility.stripSearch(this.normaliseSearch(dto.search), opts.hidden);

    // Planner estimates are untrustworthy for ILIKE / FTS predicates on
    // jsonb-extracted cells — PG falls back to a default selectivity and
    // returns numbers off by orders of magnitude. Auto-escalate such
    // requests to the capped-exact path even when the caller asked for
    // an estimate.
    const useExact = dto.exact || requiresExactCount(filter, search);

    if (useExact) {
      const { value, capped } = await this.baseRowRepo.countExact({
        pageId: dto.pageId,
        workspaceId,
        filter,
        search,
        schema,
        cap: EXACT_COUNT_CAP,
      });
      return { value, exact: true as const, capped };
    }

    const estimate = await this.baseRowRepo.countEstimate({
      pageId: dto.pageId,
      workspaceId,
      filter,
      search,
      schema,
    });
    return {
      value: estimate ?? 0,
      exact: false as const,
      capped: false,
    };
  }

  async reorder(dto: ReorderRowDto, workspaceId: string, userId?: string) {
    const row = await this.baseRowRepo.findById(dto.rowId, { workspaceId });
    if (!row || row.pageId !== dto.pageId) {
      throw new NotFoundException('Row not found');
    }

    try {
      generateJitteredKeyBetween(dto.position, null);
    } catch {
      throw new BadRequestException('Invalid position value');
    }

    await this.baseRowRepo.updatePosition(dto.rowId, dto.position, {
      pageId: dto.pageId,
      workspaceId,
    });

    const event: BaseRowReorderedEvent = {
      pageId: dto.pageId,
      workspaceId,
      actorId: userId ?? null,
      requestId: dto.requestId ?? null,
      rowId: dto.rowId,
      position: dto.position,
    };
    this.eventEmitter.emit(EventName.BASE_ROW_REORDERED, event);
  }

  // --- private helpers ------------------------------------------------

  private normaliseFilter(dto: { filter?: unknown }): FilterNode | undefined {
    if (!dto.filter) return undefined;

    const parsed = filterGroupSchema.safeParse(dto.filter);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid filter tree',
        issues: parsed.error.issues,
      });
    }
    try {
      validateFilterTree(parsed.data);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return parsed.data;
  }

  private normaliseSearch(raw: unknown): SearchSpec | undefined {
    if (raw == null) return undefined;
    const parsed = searchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid search spec',
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private validateCells(
    cells: Record<string, unknown>,
    properties: BaseProperty[],
  ): Record<string, unknown> {
    const propertyMap = new Map(properties.map((p) => [p.id, p]));
    const validatedCells: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const [propertyId, value] of Object.entries(cells)) {
      const property = propertyMap.get(propertyId);
      if (!property) {
        errors.push(`Unknown property: ${propertyId}`);
        continue;
      }

      if (isSystemPropertyType(property.type)) {
        continue;
      }

      if (value === null || value === undefined) {
        validatedCells[propertyId] = null;
        continue;
      }

      // A relation accepts one id or a list; the cell is always a list.
      const normalized =
        property.type === BasePropertyType.RELATION && typeof value === 'string'
          ? [value]
          : value;
      const result = validateCellValue(
        property.type as BasePropertyTypeValue,
        normalized,
      );

      if (!result.success) {
        errors.push(
          `Invalid value for property "${property.name}" (${property.type}): ${result.error.issues[0]?.message}`,
        );
        continue;
      }

      const choiceError = checkChoiceMembership(property, result.data);
      if (choiceError) {
        errors.push(choiceError);
        continue;
      }

      validatedCells[propertyId] = result.data;
    }

    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Cell validation failed',
        errors,
      });
    }

    return validatedCells;
  }
}

// Any filter op whose SQL is ILIKE-based, or a present search term. The
// PG planner has no stats for `cells->>'uuid' ILIKE '%x%'` / `search_text
// ILIKE` / `search_tsv @@` and falls back to a default selectivity, so
// EXPLAIN Plan Rows is worthless here — route to the capped-exact count.
const FUZZY_OPS: ReadonlySet<string> = new Set([
  'contains',
  'ncontains',
  'startsWith',
  'endsWith',
]);

function requiresExactCount(
  filter: FilterNode | undefined,
  search: SearchSpec | undefined,
): boolean {
  if (search) return true;
  if (!filter) return false;
  return filterHasFuzzyOp(filter);
}

function filterHasFuzzyOp(node: FilterNode): boolean {
  if ('children' in node) {
    return node.children.some(filterHasFuzzyOp);
  }
  return FUZZY_OPS.has((node as Condition).op);
}

// Select, status and multi-select cells must point at options the property
// actually has; the zod schema only checks the id shape.
function checkChoiceMembership(
  property: BaseProperty,
  value: unknown,
): string | null {
  const type = property.type;
  if (
    type !== BasePropertyType.SELECT &&
    type !== BasePropertyType.STATUS &&
    type !== BasePropertyType.MULTI_SELECT
  ) {
    return null;
  }
  const choices = ((property.typeOptions as any)?.choices ?? []) as Array<{
    id: string;
  }>;
  const ids = new Set(choices.map((c) => c.id));
  const values = Array.isArray(value) ? value : [value];
  const unknown = values.filter((v) => !ids.has(String(v)));
  return unknown.length > 0
    ? `Unknown option for property "${property.name}": ${unknown.join(', ')}`
    : null;
}
