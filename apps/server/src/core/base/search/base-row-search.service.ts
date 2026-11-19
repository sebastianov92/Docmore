import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BasePropertyType } from '../base.schemas';

export type BaseRowHit = {
  id: string;
  rowId: string;
  slugId: string;
  title: string;
  icon: string | null;
  parentPageId: string | null;
  creatorId: string | null;
  rank: number;
  highlight: string;
  matchedText: string[];
  wholeWord: boolean;
  createdAt: Date;
  updatedAt: Date;
  space: { id: string; slug: string; name: string };
  isBaseRow: true;
};

const MAX_HITS = 8;
const SNIPPET = 90;

// Rows of bases whose cells contain the search text, shaped like page hits
// so the spotlight lists them next to pages (the link opens the row).
@Injectable()
export class BaseRowSearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
  ) {}

  async search(
    query: string | undefined,
    userId: string,
    workspaceId: string,
    spaceId?: string,
  ): Promise<BaseRowHit[]> {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];
    const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`;

    let rows = this.db
      .selectFrom('baseRows as r')
      .innerJoin('pages as p', 'p.id', 'r.pageId')
      .innerJoin('spaces as s', 's.id', 'p.spaceId')
      .select([
        'r.id as rowId',
        'r.cells',
        'r.createdAt',
        'r.updatedAt',
        'p.id as pageId',
        'p.slugId',
        'p.title',
        'p.icon',
        'p.parentPageId',
        'p.creatorId',
        'p.spaceId',
        's.slug as spaceSlug',
        's.name as spaceName',
      ])
      .where('p.workspaceId', '=', workspaceId)
      .where('p.isBase', '=', true)
      .where('p.deletedAt', 'is', null)
      .where('r.deletedAt', 'is', null)
      .where('r.isTemplate', '=', false)
      .where(
        'p.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId, { excludeArchived: true }),
      )
      .where(sql<boolean>`r.cells::text ILIKE ${pattern}`)
      .orderBy('r.updatedAt', 'desc')
      .limit(MAX_HITS * 3);
    if (spaceId) rows = rows.where('p.spaceId', '=', spaceId);
    const found = await rows.execute();
    if (found.length === 0) return [];

    const readable = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: [...new Set(found.map((r) => r.pageId))],
        userId,
      }),
    );
    const hits: BaseRowHit[] = [];
    const propertyCache = new Map<string, Awaited<ReturnType<BasePropertyRepo['findByPageId']>>>();
    for (const row of found) {
      if (!readable.has(row.pageId)) continue;
      let properties = propertyCache.get(row.pageId);
      if (!properties) {
        properties = await this.basePropertyRepo.findByPageId(row.pageId);
        propertyCache.set(row.pageId, properties);
      }
      const cells = (row.cells ?? {}) as Record<string, unknown>;
      const primary = properties.find((p) => p.isPrimary);
      const primaryText = primary ? textOf(cells[primary.id]) : '';
      const match = findMatch(properties, cells, q);
      if (!match && !primaryText.toLowerCase().includes(q.toLowerCase())) continue;
      hits.push({
        id: row.pageId,
        rowId: row.rowId,
        slugId: row.slugId,
        title: `${row.title || 'Untitled base'} · ${primaryText || 'Untitled'}`,
        icon: row.icon,
        parentPageId: row.parentPageId,
        creatorId: row.creatorId,
        rank: 0,
        highlight: match ?? primaryText,
        matchedText: [q],
        wholeWord: false,
        createdAt: row.createdAt as Date,
        updatedAt: row.updatedAt as Date,
        space: { id: row.spaceId, slug: row.spaceSlug, name: row.spaceName },
        isBaseRow: true,
      });
      if (hits.length >= MAX_HITS) break;
    }
    return hits;
  }
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(', ');
  return '';
}

// "Property: …text around the match…" for the first cell containing the
// query; option ids are translated to their names first.
function findMatch(
  properties: Array<{ id: string; name: string; type: string; typeOptions: unknown }>,
  cells: Record<string, unknown>,
  q: string,
): string | null {
  const needle = q.toLowerCase();
  for (const property of properties) {
    let value = cells[property.id];
    if (value === undefined || value === null) continue;
    if (
      property.type === BasePropertyType.SELECT ||
      property.type === BasePropertyType.STATUS ||
      property.type === BasePropertyType.MULTI_SELECT
    ) {
      const choices = ((property.typeOptions as { choices?: Array<{ id: string; name: string }> } | null)?.choices ?? []);
      const ids = Array.isArray(value) ? value : [value];
      value = ids.map((id) => choices.find((c) => c.id === id)?.name ?? '').filter(Boolean);
    }
    const text = textOf(value);
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const start = Math.max(0, at - Math.floor(SNIPPET / 3));
    const slice = text.slice(start, start + SNIPPET);
    return `${property.name}: ${start > 0 ? '…' : ''}${slice}${start + SNIPPET < text.length ? '…' : ''}`;
  }
  return null;
}
