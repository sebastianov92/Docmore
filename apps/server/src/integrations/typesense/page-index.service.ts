import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { QueueJob, QueueName } from '../queue/constants';
import { PAGES_COLLECTION, PageDocument, TypesenseService } from './typesense.service';

const BATCH = 200;
// Bodies beyond this are indexed by their first part.
const MAX_CONTENT_CHARS = 200_000;

// Keeps the pages collection in step with the pages table. Every page is
// upserted on start (cheap at homelab size), then the search queue's page,
// space and workspace events keep it current.
@Injectable()
export class PageIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PageIndexService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly typesense: TypesenseService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private readonly searchQueue: Queue,
  ) {}

  async onApplicationBootstrap() {
    if (!this.typesense.enabled) return;
    try {
      await this.searchQueue.add(
        QueueJob.SEARCH_INDEX_PAGES,
        {},
        { deduplication: { id: 'typesense-backfill' }, removeOnComplete: true, removeOnFail: true, delay: 5_000 },
      );
    } catch (err: any) {
      this.logger.warn(`Could not queue the Typesense backfill: ${err?.message}`);
    }
  }

  async requestBackfill(workspaceId?: string) {
    await this.searchQueue.add(
      QueueJob.SEARCH_INDEX_PAGES,
      { workspaceId },
      { removeOnComplete: true, removeOnFail: true },
    );
  }

  // Page events fire inside the writing transaction, so the index job runs
  // a moment later and reads what was committed; one job per page per
  // window keeps a typing burst to one upsert.
  async scheduleIndex(pageIds: string[], delayMs = 2_000) {
    if (!pageIds?.length || !this.typesense.enabled) return;
    const bucket = Math.floor(Date.now() / delayMs);
    for (const pageId of pageIds) {
      await this.searchQueue.add(
        QueueJob.SEARCH_INDEX_PAGE,
        { pageIds: [pageId] },
        { jobId: `ts-index-${pageId}-${bucket}`, delay: delayMs, removeOnComplete: true, removeOnFail: true },
      );
    }
  }

  async indexPages(pageIds: string[]) {
    if (!pageIds?.length || !(await this.available())) return;
    const docs = await this.loadDocuments({ pageIds });
    const missing = pageIds.filter((id) => !docs.some((d) => d.id === id));
    if (docs.length) await this.upsert(docs);
    // Trashed or gone pages leave the index.
    if (missing.length) await this.removePages(missing);
  }

  async removePages(pageIds: string[]) {
    if (!pageIds?.length || !(await this.available())) return;
    await this.deleteWhere(`id:=[${pageIds.map(quote).join(',')}]`);
  }

  async removeSpace(spaceId: string) {
    if (!spaceId || !(await this.available())) return;
    await this.deleteWhere(`spaceId:=${quote(spaceId)}`);
  }

  async removeWorkspace(workspaceId: string) {
    if (!workspaceId || !(await this.available())) return;
    await this.deleteWhere(`workspaceId:=${quote(workspaceId)}`);
  }

  // Everything live, in id order, batch by batch.
  async backfill(workspaceId?: string): Promise<number> {
    if (!(await this.available())) return 0;
    let after: string | null = null;
    let total = 0;
    for (;;) {
      const docs = await this.loadDocuments({ workspaceId, afterId: after, limit: BATCH });
      if (docs.length === 0) break;
      await this.upsert(docs);
      total += docs.length;
      after = docs[docs.length - 1].id;
      if (docs.length < BATCH) break;
    }
    await this.removeStale(workspaceId);
    this.logger.log(`Typesense backfill done: ${total} pages${workspaceId ? ` in workspace ${workspaceId}` : ''}`);
    return total;
  }

  // Documents whose page is gone or trashed (rows removed outside the app,
  // restores from backups) leave the index with the backfill.
  private async removeStale(workspaceId?: string) {
    const client = this.typesense.getClient();
    const exported: string = await client
      .collections(PAGES_COLLECTION)
      .documents()
      .export({ include_fields: 'id,workspaceId', ...(workspaceId ? { filter_by: `workspaceId:=${quote(workspaceId)}` } : {}) } as any);
    const indexed = exported
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).id as string;
        } catch {
          return null;
        }
      })
      .filter((id): id is string => Boolean(id));
    if (indexed.length === 0) return;
    const live = new Set<string>();
    for (let i = 0; i < indexed.length; i += 500) {
      const rows = await this.db
        .selectFrom('pages')
        .select('id')
        .where('id', 'in', indexed.slice(i, i + 500))
        .where('deletedAt', 'is', null)
        .execute();
      rows.forEach((r) => live.add(r.id));
    }
    const stale = indexed.filter((id) => !live.has(id));
    for (let i = 0; i < stale.length; i += 100) {
      await this.deleteWhere(`id:=[${stale.slice(i, i + 100).map(quote).join(',')}]`);
    }
    if (stale.length) this.logger.log(`Removed ${stale.length} stale documents from Typesense`);
  }

  private async available(): Promise<boolean> {
    if (!this.typesense.enabled) return false;
    return this.typesense.ready || this.typesense.ensureCollection();
  }

  private async upsert(docs: PageDocument[]) {
    const results = await this.typesense
      .getClient()
      .collections(PAGES_COLLECTION)
      .documents()
      .import(docs, { action: 'upsert' });
    const failed = (results as any[]).filter((r) => r && r.success === false);
    if (failed.length) {
      this.logger.warn(`Typesense rejected ${failed.length} page documents: ${JSON.stringify(failed[0]).slice(0, 200)}`);
    }
  }

  private async deleteWhere(filterBy: string) {
    await this.typesense.getClient().collections(PAGES_COLLECTION).documents().delete({ filter_by: filterBy });
  }

  private async loadDocuments(opts: {
    pageIds?: string[];
    workspaceId?: string;
    afterId?: string | null;
    limit?: number;
  }): Promise<PageDocument[]> {
    let query = this.db
      .selectFrom('pages')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select([
        'pages.id as id',
        'pages.workspaceId as workspaceId',
        'pages.spaceId as spaceId',
        'pages.slugId as slugId',
        'pages.title as title',
        'pages.textContent as textContent',
        'pages.icon as icon',
        'pages.parentPageId as parentPageId',
        'pages.creatorId as creatorId',
        'pages.createdAt as createdAt',
        'pages.updatedAt as updatedAt',
        'spaces.archivedAt as spaceArchivedAt',
        sql<string[]>`coalesce((select array_agg(label_id::text) from page_labels where page_labels.page_id = pages.id), '{}')`.as(
          'labelIds',
        ),
      ])
      .where('pages.deletedAt', 'is', null)
      .orderBy('pages.id', 'asc');
    if (opts.pageIds) query = query.where('pages.id', 'in', opts.pageIds);
    if (opts.workspaceId) query = query.where('pages.workspaceId', '=', opts.workspaceId);
    if (opts.afterId) query = query.where('pages.id', '>', opts.afterId);
    if (opts.limit) query = query.limit(opts.limit);
    const rows = await query.execute();
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      spaceId: row.spaceId,
      spaceArchived: Boolean(row.spaceArchivedAt),
      slugId: row.slugId,
      title: row.title ?? '',
      content: (row.textContent ?? '').slice(0, MAX_CONTENT_CHARS),
      icon: row.icon ?? '',
      parentPageId: row.parentPageId ?? '',
      creatorId: row.creatorId ?? '',
      labelIds: Array.isArray(row.labelIds) ? row.labelIds : [],
      createdAt: new Date(row.createdAt).getTime(),
      updatedAt: new Date(row.updatedAt).getTime(),
    }));
  }
}

function quote(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}
