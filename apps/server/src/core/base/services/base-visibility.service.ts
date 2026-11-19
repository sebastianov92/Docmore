import { ForbiddenException, Injectable } from '@nestjs/common';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { UserRole } from '../../../common/helpers/types/permission';
import { User } from '@docmost/db/types/entity.types';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { stripPropertyFromViewConfig } from './strip-property-from-view-config';

// Who may see a column: every reader, editors and admins, or admins only.
export type VisibilityLevel = 'all' | 'editors' | 'admins';
const RANK: Record<VisibilityLevel, number> = { all: 0, editors: 1, admins: 2 };

type PropertyLike = { id: string; restrictedTo?: string | null };

@Injectable()
export class BaseVisibilityService {
  constructor(
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly basePropertyRepo: BasePropertyRepo,
  ) {}

  async levelFor(user: User | null | undefined, spaceId: string): Promise<VisibilityLevel> {
    if (!user) return 'all';
    if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) return 'admins';
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) return 'admins';
    if (ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) return 'editors';
    return 'all';
  }

  hiddenIds(properties: PropertyLike[], level: VisibilityLevel): Set<string> {
    const mine = RANK[level];
    return new Set(
      properties
        .filter((p) => RANK[((p.restrictedTo as VisibilityLevel) ?? 'all')] > mine)
        .map((p) => p.id),
    );
  }

  // The columns this user may not see in this base.
  async hiddenFor(user: User | null | undefined, base: { id: string; spaceId: string }): Promise<Set<string>> {
    const properties = await this.basePropertyRepo.findByPageId(base.id);
    if (!properties.some((p) => (p as any).restrictedTo && (p as any).restrictedTo !== 'all')) return new Set();
    return this.hiddenIds(properties as any, await this.levelFor(user, base.spaceId));
  }

  async hiddenForPublic(pageId: string): Promise<Set<string>> {
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    return this.hiddenIds(properties as any, 'all');
  }

  stripRows<T extends { cells?: unknown }>(rows: T[], hidden: Set<string> | undefined): T[] {
    if (!hidden || hidden.size === 0) return rows;
    for (const row of rows) {
      const cells = (row.cells ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cells)) if (!hidden.has(k)) next[k] = v;
      row.cells = next;
    }
    return rows;
  }

  // Base info without the hidden columns and without view settings that
  // name them.
  stripBaseInfo<T extends { properties?: PropertyLike[]; views?: Array<{ config?: unknown }> }>(info: T, hidden: Set<string>): T {
    if (hidden.size === 0) return info;
    const properties = (info.properties ?? []).filter((p) => !hidden.has(p.id));
    const views = (info.views ?? []).map((v) => {
      let config = (v.config ?? {}) as any;
      for (const id of hidden) config = stripPropertyFromViewConfig(config, id);
      return { ...v, config };
    });
    return { ...info, properties, views };
  }

  assertWritable(cells: Record<string, unknown>, hidden: Set<string> | undefined): void {
    if (!hidden || hidden.size === 0) return;
    for (const key of Object.keys(cells)) {
      if (hidden.has(key)) throw new ForbiddenException('That property is not visible to you');
    }
  }

  // Filter conditions on hidden columns are dropped (they would reveal values).
  stripFilter<T>(filter: T, hidden: Set<string> | undefined): T {
    if (!hidden || hidden.size === 0 || !filter) return filter;
    const prune = (node: any): any => {
      if (!node) return node;
      if (Array.isArray(node.children)) {
        const children = node.children.map(prune).filter(Boolean);
        return children.length ? { ...node, children } : null;
      }
      return node.propertyId && hidden.has(node.propertyId) ? null : node;
    };
    return (prune(filter) ?? undefined) as T;
  }

  stripSearch<T extends { excludeKeys?: string[] } | undefined>(search: T, hidden: Set<string> | undefined): T {
    if (!search || !hidden || hidden.size === 0) return search;
    return { ...search, excludeKeys: [...(search.excludeKeys ?? []), ...hidden] } as T;
  }
}
