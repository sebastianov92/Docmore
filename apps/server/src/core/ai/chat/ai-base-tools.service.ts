import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { z } from 'zod';
import { validate as isValidUUID } from 'uuid';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseProperty, Page, User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseViewRepo } from '@docmost/db/repos/base/base-view.repo';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BaseRowService } from '../../base/services/base-row.service';
import { BasePropertyType } from '../../base/base.schemas';

type Ctx = { user: User; workspace: Workspace; readOnly: boolean };
type Wrap = (name: string, fn: (args: any) => Promise<unknown>) => (args: any) => Promise<unknown>;

export interface BaseToolDefinition {
  name: string;
  description: string;
  scope: 'read' | 'write';
  schema: any;
  execute: (args: any) => Promise<unknown>;
}

type Choice = { id: string; name: string; color?: string };

const sortSchema = z.object({
  propertyId: z.string().min(1).max(100).describe('Property id or name'),
  direction: z.enum(['asc', 'desc']),
});

// Tools over bases (databases in pages) for the chat and the MCP server.
// Cells travel keyed by property name with select options by name, so a
// model never has to juggle ids; permissions are the page's.
@Injectable()
export class AiBaseToolsService {
  private readonly logger = new Logger(AiBaseToolsService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseViewRepo: BaseViewRepo,
    private readonly pageAccess: PageAccessService,
    private readonly baseRowService: BaseRowService,
  ) {}

  definitions(ctx: Ctx, wrap: Wrap): BaseToolDefinition[] {
    const tools: BaseToolDefinition[] = [
      {
        name: 'list_bases',
        scope: 'read',
        description:
          'List the bases (databases inside pages) the user can read, with their properties. Optionally only one space or titles containing a text.',
        schema: z.object({
          spaceId: z.string().uuid().optional().describe('Limit to this space'),
          query: z.string().max(200).optional().describe('Only bases whose title contains this'),
        }),
        execute: wrap('list_bases', async ({ spaceId, query }: { spaceId?: string; query?: string }) =>
          this.listBases(ctx, spaceId, query),
        ),
      },
      {
        name: 'get_base',
        scope: 'read',
        description:
          'Describe one base: its properties (name, type, select options), its views and the number of rows. Takes the base page id or slugId.',
        schema: z.object({
          pageId: z.string().min(1).max(100).describe('The base page id or slugId'),
        }),
        execute: wrap('get_base', async ({ pageId }: { pageId: string }) => this.getBase(ctx, pageId)),
      },
      {
        name: 'list_base_rows',
        scope: 'read',
        description:
          'Rows of a base with cells keyed by property name (select options and people shown by name). Supports a text search, a filter tree {op:"and"|"or", children:[{propertyId, op, value}]} with ops eq neq gt gte lt lte contains ncontains startsWith endsWith isEmpty isNotEmpty before after onOrBefore onOrAfter any none all, sorts, and a cursor for the next page.',
        schema: z.object({
          pageId: z.string().min(1).max(100).describe('The base page id or slugId'),
          search: z.string().max(500).optional().describe('Text to look for in any cell'),
          filter: z.record(z.string(), z.unknown()).optional().describe('Filter tree; property names are accepted as propertyId'),
          sorts: z.array(sortSchema).max(5).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().max(500).optional().describe('nextCursor of the previous call'),
        }),
        execute: wrap('list_base_rows', async (args: any) => this.listRows(ctx, args)),
      },
    ];

    if (!ctx.readOnly) {
      tools.push(
        {
          name: 'create_base_row',
          scope: 'write',
          description:
            'Add a row to a base. Cells are keyed by property name or id; select, status and multi-select values are option names; dates are ISO strings; people are user ids.',
          schema: z.object({
            pageId: z.string().min(1).max(100).describe('The base page id or slugId'),
            cells: z.record(z.string(), z.unknown()).describe('Values keyed by property name'),
          }),
          execute: wrap('create_base_row', async ({ pageId, cells }: { pageId: string; cells: Record<string, unknown> }) =>
            this.createRow(ctx, pageId, cells),
          ),
        },
        {
          name: 'update_base_row',
          scope: 'write',
          description:
            'Change cells of one row. Only the given cells change; a null value clears a cell. Same value rules as create_base_row.',
          schema: z.object({
            pageId: z.string().min(1).max(100).describe('The base page id or slugId'),
            rowId: z.string().uuid().describe('The row id'),
            cells: z.record(z.string(), z.unknown()).describe('Values keyed by property name'),
          }),
          execute: wrap(
            'update_base_row',
            async ({ pageId, rowId, cells }: { pageId: string; rowId: string; cells: Record<string, unknown> }) =>
              this.updateRow(ctx, pageId, rowId, cells),
          ),
        },
      );
    }
    return tools;
  }

  // ---- reads ----------------------------------------------------------------

  private async listBases(ctx: Ctx, spaceId?: string, query?: string) {
    let q = this.db
      .selectFrom('pages')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select(['pages.id', 'pages.title', 'pages.slugId', 'pages.spaceId', 'pages.updatedAt', 'spaces.slug as spaceSlug', 'spaces.name as spaceName'])
      .where('pages.workspaceId', '=', ctx.workspace.id)
      .where('pages.isBase', '=', true)
      .where('pages.deletedAt', 'is', null)
      .where('pages.spaceId', 'in', this.spaceMemberRepo.getUserSpaceIdsQuery(ctx.user.id, { excludeArchived: true }))
      .orderBy('pages.updatedAt', 'desc')
      .limit(100);
    if (spaceId) q = q.where('pages.spaceId', '=', spaceId);
    // an agent kept to one space sees only its bases
    if ((ctx as any).spaceId) q = q.where('pages.spaceId', '=', (ctx as any).spaceId);
    if (query?.trim()) q = q.where('pages.title', 'ilike', `%${query.trim().replace(/[%_]/g, '\\$&')}%`);
    const pages = await q.execute();
    const readable = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: pages.map((p) => p.id),
        userId: ctx.user.id,
      }),
    );
    const visible = pages.filter((p) => readable.has(p.id)).slice(0, 50);
    const items = [];
    for (const page of visible) {
      const properties = await this.basePropertyRepo.findByPageId(page.id);
      items.push({
        id: page.id,
        title: page.title || 'Untitled base',
        url: pageUrl(page.spaceSlug, page.slugId),
        space: { id: page.spaceId, name: page.spaceName },
        updatedAt: page.updatedAt,
        properties: properties.map((p) => ({ id: p.id, name: p.name, type: p.type })),
      });
    }
    return { items, total: visible.length };
  }

  private async getBase(ctx: Ctx, idOrSlug: string) {
    const page = await this.findReadableBase(ctx, idOrSlug);
    const [properties, views, count, space] = await Promise.all([
      this.basePropertyRepo.findByPageId(page.id),
      this.baseViewRepo.findByPageId(page.id, { workspaceId: page.workspaceId }),
      this.db
        .selectFrom('baseRows')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('pageId', '=', page.id)
        .where('deletedAt', 'is', null)
        .executeTakeFirst(),
      this.db.selectFrom('spaces').select(['slug', 'name']).where('id', '=', page.spaceId).executeTakeFirst(),
    ]);
    return {
      id: page.id,
      title: page.title || 'Untitled base',
      url: pageUrl(space?.slug ?? null, page.slugId),
      space: { id: page.spaceId, name: space?.name ?? null },
      rowCount: Number(count?.count ?? 0),
      properties: properties.map((p) => this.describeProperty(p)),
      views: (views as any[]).map((v) => ({ id: v.id, name: v.name, type: v.type })),
    };
  }

  private async listRows(
    ctx: Ctx,
    args: { pageId: string; search?: string; filter?: Record<string, unknown>; sorts?: Array<{ propertyId: string; direction: 'asc' | 'desc' }>; limit?: number; cursor?: string },
  ) {
    const page = await this.findReadableBase(ctx, args.pageId);
    const properties = await this.basePropertyRepo.findByPageId(page.id);
    const byName = nameIndex(properties);
    const resolveId = (ref: string) => byName.get(ref.trim().toLowerCase())?.id ?? ref;
    const filter = args.filter ? this.remapFilter(args.filter, resolveId) : undefined;
    const sorts = args.sorts?.map((s) => ({ propertyId: resolveId(s.propertyId), direction: s.direction }));
    const result: any = await this.baseRowService.list(
      {
        pageId: page.id,
        filter,
        sorts,
        search: args.search?.trim() ? { query: args.search.trim() } : undefined,
      } as any,
      { limit: args.limit ?? 50, cursor: args.cursor } as any,
      ctx.workspace.id,
    );
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', page.spaceId).executeTakeFirst();
    const base = pageUrl(space?.slug ?? null, page.slugId);
    const people = await this.peopleNames(ctx.workspace.id, result.items, properties);
    return {
      rows: result.items.map((row: any) => ({
        id: row.id,
        url: `${base}?row=${row.id}`,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        cells: this.cellsForOutput(properties, row.cells ?? {}, people),
      })),
      nextCursor: result.meta?.nextCursor ?? null,
      hasNextPage: Boolean(result.meta?.hasNextPage),
    };
  }

  // ---- writes ---------------------------------------------------------------

  private async createRow(ctx: Ctx, idOrSlug: string, cells: Record<string, unknown>) {
    const page = await this.findReadableBase(ctx, idOrSlug);
    await this.pageAccess.validateCanEdit(page, ctx.user);
    const properties = await this.basePropertyRepo.findByPageId(page.id);
    const mapped = this.cellsFromInput(properties, cells);
    const row: any = await this.baseRowService.create(ctx.user.id, ctx.workspace.id, {
      pageId: page.id,
      cells: mapped,
    } as any);
    return this.rowResult(page, properties, row);
  }

  private async updateRow(ctx: Ctx, idOrSlug: string, rowId: string, cells: Record<string, unknown>) {
    const page = await this.findReadableBase(ctx, idOrSlug);
    await this.pageAccess.validateCanEdit(page, ctx.user);
    const properties = await this.basePropertyRepo.findByPageId(page.id);
    const mapped = this.cellsFromInput(properties, cells);
    const row: any = await this.baseRowService.update(
      { pageId: page.id, rowId, cells: mapped } as any,
      ctx.workspace.id,
      ctx.user.id,
    );
    return this.rowResult(page, properties, row);
  }

  // ---- helpers --------------------------------------------------------------

  private async findReadableBase(ctx: Ctx, idOrSlug: string): Promise<Page> {
    let pageId = idOrSlug.trim();
    if (!isValidUUID(pageId)) {
      const bySlug = await this.db
        .selectFrom('pages')
        .select('id')
        .where('slugId', '=', pageId)
        .where('workspaceId', '=', ctx.workspace.id)
        .executeTakeFirst();
      if (!bySlug) throw new Error(`Base ${idOrSlug} not found`);
      pageId = bySlug.id;
    }
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== ctx.workspace.id || page.deletedAt) {
      throw new Error(`Base ${idOrSlug} not found`);
    }
    if (!(page as any).isBase) throw new Error(`Page ${idOrSlug} is not a base`);
    if ((ctx as any).spaceId && page.spaceId !== (ctx as any).spaceId) throw new Error(`Base ${idOrSlug} not found`);
    await this.pageAccess.validateCanView(page, ctx.user);
    return page;
  }

  private describeProperty(p: BaseProperty) {
    const options = (p.typeOptions as { choices?: Choice[] } | null)?.choices;
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      ...(p.isPrimary ? { primary: true } : {}),
      ...(options ? { options: options.map((c) => c.name) } : {}),
      ...(p.type === BasePropertyType.FORMULA
        ? { formula: (p.typeOptions as { source?: string } | null)?.source }
        : {}),
    };
  }

  private remapFilter(node: Record<string, unknown>, resolveId: (ref: string) => string): Record<string, unknown> {
    if (Array.isArray(node.children)) {
      return { ...node, children: (node.children as Record<string, unknown>[]).map((c) => this.remapFilter(c, resolveId)) };
    }
    if (typeof node.propertyId === 'string') {
      return { ...node, propertyId: resolveId(node.propertyId) };
    }
    return node;
  }

  // Property names → ids, option names → ids; anything else as given.
  private cellsFromInput(properties: BaseProperty[], cells: Record<string, unknown>): Record<string, unknown> {
    const byName = nameIndex(properties);
    const byId = new Map(properties.map((p) => [p.id, p]));
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(cells ?? {})) {
      const property = byId.get(key) ?? byName.get(key.trim().toLowerCase());
      if (!property) throw new Error(`Unknown property "${key}"`);
      if (raw === null || raw === undefined) {
        out[property.id] = null;
        continue;
      }
      const choices = (property.typeOptions as { choices?: Choice[] } | null)?.choices ?? [];
      const toChoiceId = (value: unknown): string => {
        const text = String(value).trim();
        const hit = choices.find((c) => c.id === text || c.name.toLowerCase() === text.toLowerCase());
        if (!hit) throw new Error(`Unknown option "${text}" for "${property.name}"; options: ${choices.map((c) => c.name).join(', ')}`);
        return hit.id;
      };
      if (property.type === BasePropertyType.SELECT || property.type === BasePropertyType.STATUS) {
        out[property.id] = toChoiceId(Array.isArray(raw) ? raw[0] : raw);
      } else if (property.type === BasePropertyType.MULTI_SELECT) {
        const list = Array.isArray(raw) ? raw : String(raw).split(',');
        out[property.id] = list.map((v) => toChoiceId(v));
      } else if (property.type === BasePropertyType.DATE && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        out[property.id] = new Date(`${raw}T00:00:00.000Z`).toISOString();
      } else {
        out[property.id] = raw;
      }
    }
    return out;
  }

  private cellsForOutput(
    properties: BaseProperty[],
    cells: Record<string, unknown>,
    people: Map<string, string>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const property of properties) {
      const value = cells[property.id];
      if (value === undefined || value === null) continue;
      const choices = (property.typeOptions as { choices?: Choice[] } | null)?.choices ?? [];
      const choiceName = (id: unknown) => choices.find((c) => c.id === id)?.name ?? id;
      if (property.type === BasePropertyType.SELECT || property.type === BasePropertyType.STATUS) {
        out[property.name] = choiceName(value);
      } else if (property.type === BasePropertyType.MULTI_SELECT && Array.isArray(value)) {
        out[property.name] = value.map(choiceName);
      } else if (property.type === BasePropertyType.PERSON) {
        const ids = Array.isArray(value) ? value : [value];
        out[property.name] = ids.map((id) => people.get(String(id)) ?? id);
      } else if (property.type === BasePropertyType.FILE && Array.isArray(value)) {
        out[property.name] = value.map((f: any) => f?.fileName ?? f);
      } else {
        out[property.name] = value;
      }
    }
    return out;
  }

  private async peopleNames(workspaceId: string, rows: any[], properties: BaseProperty[]) {
    const personProps = properties.filter((p) => p.type === BasePropertyType.PERSON).map((p) => p.id);
    const ids = new Set<string>();
    for (const row of rows) {
      for (const pid of personProps) {
        const v = row.cells?.[pid];
        for (const id of Array.isArray(v) ? v : v ? [v] : []) ids.add(String(id));
      }
    }
    const map = new Map<string, string>();
    if (ids.size === 0) return map;
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'email'])
      .where('workspaceId', '=', workspaceId)
      .where('id', 'in', [...ids])
      .execute();
    for (const u of users) map.set(u.id, u.name || u.email);
    return map;
  }

  private async rowResult(page: Page, properties: BaseProperty[], row: any) {
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', page.spaceId).executeTakeFirst();
    const people = await this.peopleNames(page.workspaceId, [row], properties);
    return {
      id: row.id,
      url: `${pageUrl(space?.slug ?? null, page.slugId)}?row=${row.id}`,
      cells: this.cellsForOutput(properties, row.cells ?? {}, people),
    };
  }
}

function nameIndex(properties: BaseProperty[]): Map<string, BaseProperty> {
  return new Map(properties.map((p) => [p.name.trim().toLowerCase(), p]));
}

function pageUrl(spaceSlug: string | null, slugId: string): string {
  return spaceSlug ? `/s/${spaceSlug}/p/${slugId}` : `/p/${slugId}`;
}
