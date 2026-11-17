import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchDTO } from './dto/search.dto';
import { AttachmentType } from '../attachment/attachment.constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

export interface AttachmentSearchResult {
  id: string;
  fileName: string;
  pageId: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  rank: number;
  highlight: string;
  space: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    archivedAt: Date | null;
  };
  page: { id: string; title: string | null; slugId: string };
}

// Full-text search over indexed attachments. Same visibility rules as page
// search: spaces the user belongs to, pages they may read, nothing deleted.
@Injectable()
export class SearchAttachmentService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async search(
    params: SearchDTO,
    opts: { userId: string; workspaceId: string },
  ): Promise<{ items: AttachmentSearchResult[] }> {
    const query = params.query?.trim() ?? '';
    if (query.length < 1) {
      return { items: [] };
    }
    const searchQuery = tsquery(query + '*');
    const tsQuery = sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`;
    const limit = Math.min(Math.max(params.limit || 25, 1), 100);
    const offset = Math.max(params.offset || 0, 0);

    const rows = await this.db
      .selectFrom('attachments')
      .innerJoin('pages', 'pages.id', 'attachments.pageId')
      .select((eb) => [
        'attachments.id as id',
        'attachments.fileName as fileName',
        'attachments.pageId as pageId',
        'attachments.creatorId as creatorId',
        'attachments.createdAt as createdAt',
        'attachments.updatedAt as updatedAt',
        sql<number>`ts_rank(attachments.tsv, ${tsQuery})`.as('rank'),
        jsonObjectFrom(
          eb
            .selectFrom('spaces')
            .select([
              'spaces.id',
              'spaces.name',
              'spaces.slug',
              'spaces.logo',
              'spaces.archivedAt',
            ])
            .whereRef('spaces.id', '=', 'attachments.spaceId'),
        ).as('space'),
        jsonObjectFrom(
          eb
            .selectFrom('pages as p')
            .select(['p.id', 'p.title', 'p.slugId'])
            .whereRef('p.id', '=', 'attachments.pageId'),
        ).as('page'),
      ])
      .where('attachments.workspaceId', '=', opts.workspaceId)
      .where('attachments.type', '=', AttachmentType.File)
      .where('attachments.deletedAt', 'is', null)
      .where('pages.deletedAt', 'is', null)
      .where('attachments.tsv', '@@', tsQuery)
      .where(
        'attachments.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId, {
          excludeArchived: !params.includeArchived,
          keepArchivedSpaceId: params.spaceId,
        }),
      )
      .$if(Boolean(params.spaceId), (qb) =>
        qb.where('attachments.spaceId', '=', params.spaceId),
      )
      .$if(Boolean(params.creatorId), (qb) =>
        qb.where('attachments.creatorId', '=', params.creatorId),
      )
      .orderBy('rank', 'desc')
      .orderBy('attachments.updatedAt', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    if (rows.length === 0) {
      return { items: [] };
    }

    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: [...new Set(rows.map((r) => r.pageId))],
        userId: opts.userId,
        spaceId: params.spaceId,
      }),
    );
    const visible = rows.filter((r) => accessible.has(r.pageId));
    if (visible.length === 0) {
      return { items: [] };
    }

    const highlights = await this.db
      .selectFrom('attachments')
      .select([
        'id',
        sql<string>`ts_headline('english', substring(coalesce(text_content, ''), 1, 100000), ${tsQuery}, 'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        ),
      ])
      .where(
        'id',
        'in',
        visible.map((r) => r.id),
      )
      .execute();
    const highlightById = new Map(highlights.map((h) => [h.id, h.highlight]));

    const items = visible.map((row) => ({
      ...row,
      highlight: cleanHighlight(highlightById.get(row.id)),
    })) as unknown as AttachmentSearchResult[];

    return { items };
  }
}

// ts_headline keeps the file's line breaks; one line reads better in a list.
function cleanHighlight(value: string | null | undefined): string {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  // A headline without a single <b> is the file's opening words, not a match.
  return /<b>/i.test(flat) ? flat : '';
}
