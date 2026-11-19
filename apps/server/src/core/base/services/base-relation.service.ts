import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BaseProperty, BaseRow } from '@docmost/db/types/entity.types';
import { BasePropertyType } from '../base.schemas';

export type RelatedRowRef = { id: string; pageId: string; title: string };

// Relations point at rows of another base; rollups aggregate over them.
// Rollup values are computed when rows are read, never stored.
@Injectable()
export class BaseRelationService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly baseRepo: BaseRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseRowRepo: BaseRowRepo,
  ) {}

  relationTarget(property: BaseProperty): string | null {
    return (property.typeOptions as any)?.targetPageId ?? null;
  }

  // Validates relation / rollup type options against live bases.
  async validateOptions(
    pageId: string,
    workspaceId: string,
    type: string,
    typeOptions: any,
    properties?: BaseProperty[],
  ): Promise<void> {
    if (type === BasePropertyType.RELATION) {
      const target = await this.baseRepo.findById(typeOptions?.targetPageId);
      if (!target || target.workspaceId !== workspaceId || target.deletedAt) {
        throw new BadRequestException('Relation target base not found');
      }
      return;
    }
    if (type === BasePropertyType.ROLLUP) {
      const props = properties ?? (await this.basePropertyRepo.findByPageId(pageId));
      const relation = props.find((p) => p.id === typeOptions?.relationPropertyId);
      if (!relation || relation.type !== BasePropertyType.RELATION) {
        throw new BadRequestException('Rollup needs a relation property of this base');
      }
      const aggregate = typeOptions?.aggregate;
      if (aggregate === 'count') return;
      const targetPageId = this.relationTarget(relation);
      const targetProps = await this.basePropertyRepo.findByPageId(targetPageId);
      const target = targetProps.find((p) => p.id === typeOptions?.targetPropertyId);
      if (!target) {
        throw new BadRequestException('Rollup needs a property of the related base');
      }
      if (['sum', 'avg', 'min', 'max'].includes(aggregate)) {
        const numeric = [BasePropertyType.NUMBER, BasePropertyType.FORMULA, BasePropertyType.ROLLUP, BasePropertyType.ID];
        if (!numeric.includes(target.type as any)) {
          throw new BadRequestException(`${aggregate} needs a number property`);
        }
      }
    }
  }

  // Every id in a relation cell must be a live row of the relation's target base.
  async assertTargets(
    cells: Record<string, unknown>,
    properties: BaseProperty[],
    workspaceId: string,
  ): Promise<void> {
    for (const property of properties) {
      if (property.type !== BasePropertyType.RELATION) continue;
      const value = cells[property.id];
      if (value === null || value === undefined) continue;
      const ids = Array.isArray(value) ? (value as string[]) : [];
      if (ids.length === 0) continue;
      const targetPageId = this.relationTarget(property);
      const found = await this.baseRowRepo.findByIds([...new Set(ids)], { workspaceId });
      const ok = new Set(found.filter((r) => r.pageId === targetPageId && !r.isTemplate).map((r) => r.id));
      const bad = ids.filter((id) => !ok.has(id));
      if (bad.length > 0) {
        throw new BadRequestException(`Related rows not found in the target base: ${bad.length}`);
      }
    }
  }

  // Loads the rows the relation cells point to, with the title of each.
  async loadRelated(
    rows: BaseRow[],
    properties: BaseProperty[],
    workspaceId: string,
  ): Promise<{ byId: Map<string, BaseRow>; refs: Record<string, RelatedRowRef> }> {
    const relations = properties.filter((p) => p.type === BasePropertyType.RELATION);
    const byId = new Map<string, BaseRow>();
    const refs: Record<string, RelatedRowRef> = {};
    const ids = new Set<string>();
    for (const row of rows) {
      const cells = (row.cells ?? {}) as Record<string, unknown>;
      for (const p of relations) {
        const value = cells[p.id];
        if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') ids.add(id);
      }
      // parents and dependencies get a title too
      if (row.parentRowId) ids.add(row.parentRowId);
      const blocked = (row as any).blockedBy;
      if (Array.isArray(blocked)) for (const id of blocked) if (typeof id === 'string') ids.add(id);
    }
    if (ids.size === 0) return { byId, refs };
    const found = await this.baseRowRepo.findByIds([...ids], { workspaceId });
    const pageIds = [...new Set(found.map((r) => r.pageId))];
    const primaryByPage = new Map<string, string>();
    for (const pid of pageIds) {
      const props = await this.basePropertyRepo.findByPageId(pid);
      const primary = props.find((p) => p.isPrimary);
      if (primary) primaryByPage.set(pid, primary.id);
    }
    for (const r of found) {
      byId.set(r.id, r);
      const primaryId = primaryByPage.get(r.pageId);
      const title = primaryId ? (r.cells as any)?.[primaryId] : null;
      refs[r.id] = { id: r.id, pageId: r.pageId, title: typeof title === 'string' ? title : '' };
    }
    return { byId, refs };
  }

  // Writes computed rollup values into row.cells (in memory only).
  async applyRollups(
    rows: BaseRow[],
    properties: BaseProperty[],
    byId: Map<string, BaseRow>,
  ): Promise<void> {
    const rollups = properties.filter((p) => p.type === BasePropertyType.ROLLUP);
    if (rollups.length === 0) return;
    const propsById = new Map(properties.map((p) => [p.id, p]));
    const targetPropsCache = new Map<string, BaseProperty[]>();
    for (const rollup of rollups) {
      const opts = (rollup.typeOptions ?? {}) as any;
      const relation = propsById.get(opts.relationPropertyId);
      if (!relation || relation.type !== BasePropertyType.RELATION) continue;
      const targetPageId = this.relationTarget(relation);
      let targetProperty: BaseProperty | undefined;
      if (opts.aggregate !== 'count' && targetPageId) {
        if (!targetPropsCache.has(targetPageId)) {
          targetPropsCache.set(targetPageId, await this.basePropertyRepo.findByPageId(targetPageId));
        }
        targetProperty = targetPropsCache.get(targetPageId)!.find((p) => p.id === opts.targetPropertyId);
      }
      for (const row of rows) {
        const cells = ((row.cells ?? {}) as Record<string, unknown>);
        const ids = Array.isArray(cells[relation.id]) ? (cells[relation.id] as string[]) : [];
        const related = ids.map((id) => byId.get(id)).filter((r): r is BaseRow => Boolean(r));
        (row as any).cells = { ...cells, [rollup.id]: this.aggregate(opts.aggregate, related, targetProperty) };
      }
    }
  }

  private valueOf(row: BaseRow, property: BaseProperty | undefined): unknown {
    if (!property) return null;
    switch (property.type) {
      case BasePropertyType.ID:
        return row.rowNo ?? null;
      case BasePropertyType.CREATED_AT:
        return row.createdAt;
      case BasePropertyType.LAST_EDITED_AT:
        return row.updatedAt;
      case BasePropertyType.LAST_EDITED_BY:
        return row.lastUpdatedById;
      default:
        return (row.cells as any)?.[property.id] ?? null;
    }
  }

  private aggregate(kind: string, related: BaseRow[], target: BaseProperty | undefined): unknown {
    if (kind === 'count') return related.length;
    const values = related.map((r) => this.valueOf(r, target)).filter((v) => v !== null && v !== undefined && v !== '');
    if (kind === 'show') {
      return values.map((v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    const numbers = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
    if (numbers.length === 0) return null;
    switch (kind) {
      case 'sum':
        return numbers.reduce((a, b) => a + b, 0);
      case 'avg':
        return numbers.reduce((a, b) => a + b, 0) / numbers.length;
      case 'min':
        return Math.min(...numbers);
      case 'max':
        return Math.max(...numbers);
      default:
        return null;
    }
  }
}
