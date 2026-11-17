import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SearchService } from '../../core/search/search.service';
import { SearchDTO } from '../../core/search/dto/search.dto';
import { PAGES_COLLECTION, TypesenseService } from './typesense.service';

interface SearchOpts {
  userId?: string;
  workspaceId: string;
  publicPageIds?: string[];
}

const MAX_LIMIT = 100;

// Page search on Typesense for signed-in members: typo tolerance, prefix
// matching and snippets, with the same visibility rules as the Postgres
// search (space membership, page permissions, archived spaces, nothing
// trashed). Share and public-space searches, browse-by-filter lists and
// anything while Typesense is down go to the Postgres search.
@Injectable()
export class PageSearchService {
  private readonly logger = new Logger(PageSearchService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly typesense: TypesenseService,
    private readonly searchService: SearchService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async searchPage(params: SearchDTO, opts: SearchOpts) {
    const query = params.query?.trim() ?? '';
    const usePostgres =
      !opts.userId || query.length < 1 || Boolean(params.shareId) || Boolean(opts.publicPageIds) || !this.typesense.ready;
    if (usePostgres) {
      return this.searchService.searchPage(params, opts);
    }
    try {
      return await this.searchTypesense(query, params, opts.userId, opts.workspaceId);
    } catch (err: any) {
      this.logger.warn(`Typesense search failed, answering from Postgres: ${err?.message ?? err}`);
      return this.searchService.searchPage(params, opts);
    }
  }

  private async searchTypesense(query: string, params: SearchDTO, userId: string, workspaceId: string) {
    const filters = [`workspaceId:=${quote(workspaceId)}`];
    if (params.spaceId) {
      filters.push(`spaceId:=${quote(params.spaceId)}`);
    } else {
      const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId, {
        excludeArchived: !params.includeArchived,
      });
      if (spaceIds.length === 0) return { items: [] };
      filters.push(`spaceId:=[${spaceIds.map(quote).join(',')}]`);
    }
    if (params.creatorId) filters.push(`creatorId:=${quote(params.creatorId)}`);
    const labelIds = [...new Set(params.labelIds ?? [])];
    for (const labelId of labelIds) filters.push(`labelIds:=${quote(labelId)}`);

    const limit = Math.min(Math.max(params.limit || 25, 1), MAX_LIMIT);
    const offset = Math.max(params.offset || 0, 0);
    const titleOnly = params.titleOnly === true;

    const result: any = await this.typesense
      .getClient()
      .collections(PAGES_COLLECTION)
      .documents()
      .search({
        q: query,
        query_by: titleOnly ? 'title' : 'title,content',
        query_by_weights: titleOnly ? '1' : '4,1',
        filter_by: filters.join(' && '),
        sort_by: '_text_match:desc,updatedAt:desc',
        highlight_fields: titleOnly ? 'title' : 'title,content',
        highlight_start_tag: '<b>',
        highlight_end_tag: '</b>',
        highlight_affix_num_tokens: 8,
        snippet_threshold: 20,
        num_typos: 1,
        prefix: true,
        exclude_fields: 'content',
        per_page: limit,
        page: Math.floor(offset / limit) + 1,
      });

    const hits: any[] = result?.hits ?? [];
    if (hits.length === 0) return { items: [] };

    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: hits.map((h) => h.document.id),
        userId,
        spaceId: params.spaceId,
      }),
    );
    const visible = hits.filter((h) => accessible.has(h.document.id));
    const spaceIds = [...new Set(visible.map((h) => h.document.spaceId as string))];
    const spaces = spaceIds.length
      ? await this.db
          .selectFrom('spaces')
          .select(['id', 'name', 'slug', 'logo', 'archivedAt'])
          .where('id', 'in', spaceIds)
          .execute()
      : [];
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    const items = visible.map((hit) => {
      const doc = hit.document;
      const snippet = pickHighlight(hit, titleOnly);
      const highlight = snippet.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ');
      return {
        id: doc.id,
        slugId: doc.slugId,
        title: doc.title || null,
        icon: doc.icon || null,
        parentPageId: doc.parentPageId || null,
        creatorId: doc.creatorId || null,
        createdAt: new Date(doc.createdAt),
        updatedAt: new Date(doc.updatedAt),
        rank: Number(hit.text_match ?? 0),
        highlight,
        matchedText: [...new Set(Array.from(highlight.matchAll(/<b>([^<]*)<\/b>/gi), (m) => m[1]))],
        wholeWord: true,
        space: spaceById.get(doc.spaceId) ?? null,
      };
    });
    return { items };
  }
}

function pickHighlight(hit: any, titleOnly: boolean): string {
  const byField = hit.highlight ?? {};
  if (!titleOnly && byField.content?.snippet) return byField.content.snippet;
  if (byField.title?.snippet) return byField.title.snippet;
  const legacy: any[] = hit.highlights ?? [];
  const content = legacy.find((h) => h.field === 'content') ?? legacy[0];
  return content?.snippet ?? '';
}

function quote(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}
