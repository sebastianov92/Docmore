import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import {
  ensurePageEmbeddingsSchema,
  PageEmbeddingsSchemaState,
} from '@docmost/db/helpers/page-embeddings.schema';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { jsonToText } from '../../../collaboration/collaboration.util';
import { AiSettingsService, ModelChoice } from '../ai-settings.service';
import { AiProviderService } from '../ai-provider.service';
import { chunkText } from './ai-chunk';

export interface AnswerSource {
  pageId: string;
  title: string;
  slugId: string;
  spaceSlug: string;
  spaceName: string;
  similarity: number;
  distance: number;
  chunkIndex: number;
  excerpt: string;
}

export interface SearchOptions {
  spaceId?: string;
  includeArchived?: boolean;
}

export interface EmbeddingStatus {
  available: boolean;
  enabled: boolean;
  model: ModelChoice | null;
  totalPages: number;
  indexedPages: number;
  pendingPages: number;
  queuedJobs: number;
  lastIndexedAt: string | null;
}

const EMBED_BATCH = 64;
// Candidates fetched from the index before access filtering.
const CANDIDATES = 40;
const MAX_SOURCES = 8;
const MAX_PER_PAGE = 3;
const MIN_RELATIVE_SIMILARITY = 0.5;
const PAGES_PER_JOB = 10;
// Saves within this window share one indexing job.
const DEBOUNCE_MS = 10_000;
const INDEXING_JOBS = new Set<QueueJob>([
  QueueJob.GENERATE_PAGE_EMBEDDINGS,
  QueueJob.WORKSPACE_CREATE_EMBEDDINGS,
  QueueJob.WORKSPACE_RESET_EMBEDDINGS,
]);

interface PageRow {
  id: string;
  title: string | null;
  textContent: string | null;
  content: unknown;
  spaceId: string;
  workspaceId: string;
  deletedAt: Date | null;
}

// Keeps page_embeddings in step with pages and answers "which pages talk
// about this" by cosine distance. One row per chunk; the chunk text is kept
// in metadata so excerpts and the answer prompt need no second read.
@Injectable()
export class AiEmbeddingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiEmbeddingService.name);
  private schema: PageEmbeddingsSchemaState | 'unknown' = 'unknown';

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly settings: AiSettingsService,
    private readonly providers: AiProviderService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  async onApplicationBootstrap() {
    await this.checkSchema();
  }

  // Creates the table when pgvector is there (also on a server that got
  // pgvector after its first start). Cached for the life of the process.
  async checkSchema(): Promise<boolean> {
    try {
      this.schema = await this.db
        .transaction()
        .execute((trx) => ensurePageEmbeddingsSchema(trx));
    } catch (err: any) {
      this.logger.warn(`Could not prepare page_embeddings: ${err?.message}`);
      this.schema = 'no-extension';
    }
    if (this.schema === 'no-extension') {
      this.logger.warn(
        'pgvector is not available on the database; AI search stays off. The pgvector/pgvector Postgres image includes it.',
      );
    }
    return this.schema === 'ready';
  }

  get available(): boolean {
    return this.schema === 'ready';
  }

  async isEnabled(workspaceId: string): Promise<boolean> {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    return (workspace?.settings as any)?.ai?.search === true;
  }

  // ---- indexing -----------------------------------------------------------

  // Called for saves: one job per page per window, so a typing burst costs
  // one embedding call. The time bucket in the id lets a later edit through
  // even while an earlier job is running.
  async scheduleIndex(pageIds: string[], workspaceId: string | undefined, delayMs = DEBOUNCE_MS) {
    if (!this.available || !pageIds?.length) return;
    // Some update events carry no workspace id; the page knows it.
    if (!workspaceId) {
      const page = await this.db
        .selectFrom('pages')
        .select('workspaceId')
        .where('id', '=', pageIds[0])
        .executeTakeFirst();
      workspaceId = page?.workspaceId;
      if (!workspaceId) return;
    }
    if (!(await this.isEnabled(workspaceId))) return;
    const bucket = Math.floor(Date.now() / DEBOUNCE_MS);
    for (const pageId of pageIds) {
      await this.aiQueue.add(
        QueueJob.GENERATE_PAGE_EMBEDDINGS,
        { pageIds: [pageId], workspaceId },
        {
          jobId: `page-embeddings-${pageId}-${bucket}`,
          delay: delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }

  async indexPages(pageIds: string[], workspaceId: string) {
    if (!this.available || !pageIds?.length) return;
    if (!(await this.isEnabled(workspaceId))) return;
    const choice = await this.settings.embeddingChoice(workspaceId);
    if (!choice) {
      this.logger.debug('AI search is on but no embedding model is chosen; skipping');
      return;
    }
    const pages = (await this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent', 'content', 'spaceId', 'workspaceId', 'deletedAt'])
      .where('id', 'in', pageIds)
      .where('workspaceId', '=', workspaceId)
      .execute()) as PageRow[];
    for (const page of pages) {
      if (page.deletedAt) {
        await this.deleteForPages([page.id]);
        continue;
      }
      await this.indexPage(page, choice);
    }
  }

  private async indexPage(page: PageRow, choice: ModelChoice) {
    const modelName = nameOf(choice);
    const title = (page.title ?? '').trim();
    const body = pageBody(page);
    const hash = sha1(`${modelName}\n${title}\n\n${body}`);

    const existing = await this.db
      .selectFrom('pageEmbeddings')
      .select([sql<string>`metadata->>'hash'`.as('hash'), 'spaceId'])
      .where('pageId', '=', page.id)
      .where('modelName', '=', modelName)
      .limit(1)
      .executeTakeFirst();
    if (existing?.hash === hash) {
      // Same text as last time; only the space may have changed.
      if (existing.spaceId !== page.spaceId) {
        await this.db
          .updateTable('pageEmbeddings')
          .set({ spaceId: page.spaceId, updatedAt: new Date() })
          .where('pageId', '=', page.id)
          .execute();
      }
      return;
    }

    // A page with a title and no body is still findable by its title.
    const chunks = chunkText(body.length > 0 ? body : title);
    if (chunks.length === 0) {
      await this.deleteForPages([page.id]);
      return;
    }
    // The title goes in front of every chunk for the embedding only, so a
    // chunk deep in a long page still knows which page it belongs to.
    const inputs = chunks.map((c) => (title && body.length > 0 ? `${title}\n\n${c.text}` : c.text));
    const vectors = await this.embed(page.workspaceId, inputs, choice);
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions) {
      throw new BadRequestException('The embedding provider returned empty vectors');
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('pageEmbeddings').where('pageId', '=', page.id).execute();
      await trx
        .insertInto('pageEmbeddings')
        .values(
          chunks.map((chunk, i) => ({
            pageId: page.id,
            spaceId: page.spaceId,
            workspaceId: page.workspaceId,
            modelName,
            modelDimensions: dimensions,
            embedding: sql`${vectorLiteral(vectors[i])}::vector` as any,
            chunkIndex: chunk.index,
            chunkStart: chunk.start,
            chunkLength: chunk.length,
            metadata: { hash, title, text: chunk.text } as any,
          })),
        )
        .execute();
    });
    this.logger.debug(`Indexed page ${page.id}: ${chunks.length} chunks, ${dimensions} dims`);
  }

  async deleteForPages(pageIds: string[]) {
    if (!this.available || !pageIds?.length) return;
    await this.db.deleteFrom('pageEmbeddings').where('pageId', 'in', pageIds).execute();
  }

  async deleteForSpace(spaceId: string) {
    if (!this.available || !spaceId) return;
    await this.db.deleteFrom('pageEmbeddings').where('spaceId', '=', spaceId).execute();
  }

  async deleteForWorkspace(workspaceId: string) {
    if (!this.available || !workspaceId) return;
    await this.db.deleteFrom('pageEmbeddings').where('workspaceId', '=', workspaceId).execute();
  }

  // Queues every page that has no current embeddings, or whose embeddings
  // are older than its last edit. With reset, everything goes first.
  async backfill(workspaceId: string, opts?: { reset?: boolean }) {
    if (!this.available) return;
    if (!(await this.isEnabled(workspaceId))) return;
    const choice = await this.settings.embeddingChoice(workspaceId);
    if (!choice) return;
    const modelName = nameOf(choice);

    if (opts?.reset) {
      await this.deleteForWorkspace(workspaceId);
    } else {
      await this.db
        .deleteFrom('pageEmbeddings')
        .where('workspaceId', '=', workspaceId)
        .where('modelName', '!=', modelName)
        .execute();
    }

    const pageIds = await this.pagesNeedingWork(workspaceId, modelName);
    for (let i = 0; i < pageIds.length; i += PAGES_PER_JOB) {
      await this.aiQueue.add(
        QueueJob.GENERATE_PAGE_EMBEDDINGS,
        { pageIds: pageIds.slice(i, i + PAGES_PER_JOB), workspaceId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
    this.logger.log(`Queued ${pageIds.length} pages for embeddings in workspace ${workspaceId}`);
  }

  async requestReindex(workspaceId: string) {
    await this.aiQueue.add(
      QueueJob.WORKSPACE_RESET_EMBEDDINGS,
      { workspaceId },
      { removeOnComplete: true, removeOnFail: true },
    );
  }

  private async pagesNeedingWork(workspaceId: string, modelName: string): Promise<string[]> {
    const result = await sql<{ id: string }>`
      SELECT p.id
      FROM pages p
      LEFT JOIN LATERAL (
        SELECT max(e.updated_at) AS at
        FROM page_embeddings e
        WHERE e.page_id = p.id AND e.model_name = ${modelName}
      ) e ON true
      WHERE p.workspace_id = ${workspaceId}
        AND p.deleted_at IS NULL
        AND (e.at IS NULL OR e.at < p.updated_at)
      ORDER BY p.updated_at DESC
    `.execute(this.db);
    return result.rows.map((r) => r.id);
  }

  // ---- search -------------------------------------------------------------

  async search(
    workspaceId: string,
    userId: string,
    query: string,
    opts: SearchOptions = {},
  ): Promise<AnswerSource[]> {
    if (!this.available) {
      throw new BadRequestException('AI search needs the pgvector extension on the database');
    }
    const choice = await this.settings.embeddingChoice(workspaceId);
    if (!choice) {
      throw new BadRequestException('No embedding model is configured. An admin can pick one under Settings > AI.');
    }
    const text = query.trim();
    if (!text) return [];
    const [vector] = await this.embed(workspaceId, [text], choice);
    const dimensions = vector.length;
    const dims = sql.raw(String(dimensions));
    const distance = sql<number>`(page_embeddings.embedding::vector(${dims}) <=> ${vectorLiteral(vector)}::vector(${dims}))`;

    let select = this.db
      .selectFrom('pageEmbeddings')
      .innerJoin('pages', 'pages.id', 'pageEmbeddings.pageId')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select([
        'pageEmbeddings.pageId as pageId',
        'pageEmbeddings.chunkIndex as chunkIndex',
        'pageEmbeddings.metadata as metadata',
        'pages.title as title',
        'pages.slugId as slugId',
        'spaces.slug as spaceSlug',
        'spaces.name as spaceName',
        distance.as('distance'),
      ])
      .where('pageEmbeddings.workspaceId', '=', workspaceId)
      .where('pageEmbeddings.modelName', '=', nameOf(choice))
      .where('pageEmbeddings.modelDimensions', '=', dimensions)
      .where('pages.deletedAt', 'is', null)
      .orderBy(distance)
      .limit(CANDIDATES);

    if (opts.spaceId) {
      select = select
        .where('pages.spaceId', '=', opts.spaceId)
        .where('pages.spaceId', 'in', this.spaceMemberRepo.getUserSpaceIdsQuery(userId));
    } else {
      select = select.where(
        'pages.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId, {
          excludeArchived: !opts.includeArchived,
        }),
      );
    }

    const rows = await select.execute();
    const pageIds = Array.from(new Set(rows.map((r) => r.pageId)));
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds,
        userId,
        spaceId: opts.spaceId,
      }),
    );

    const perPage = new Map<string, number>();
    const sources: AnswerSource[] = [];
    // Absolute similarity scales differ per model, so the cut-off is
    // relative to the best readable match; anything pointing the other way
    // is never a match.
    const best = rows.find((r) => accessible.has(r.pageId));
    const floor = best ? Math.max(0, (1 - Number(best.distance)) * MIN_RELATIVE_SIMILARITY) : 0;
    for (const row of rows) {
      if (!accessible.has(row.pageId)) continue;
      const similarity = 1 - Number(row.distance);
      if (similarity <= 0 || similarity < floor) continue;
      const used = perPage.get(row.pageId) ?? 0;
      if (used >= MAX_PER_PAGE) continue;
      perPage.set(row.pageId, used + 1);
      const metadata = asObject<{ text?: string }>(row.metadata) ?? {};
      const dist = Number(row.distance);
      sources.push({
        pageId: row.pageId,
        title: row.title || 'Untitled',
        slugId: row.slugId,
        spaceSlug: row.spaceSlug,
        spaceName: row.spaceName,
        similarity: 1 - dist,
        distance: dist,
        chunkIndex: row.chunkIndex,
        excerpt: metadata.text ?? '',
      });
      if (sources.length >= MAX_SOURCES) break;
    }
    return sources;
  }

  // ---- status -------------------------------------------------------------

  async status(workspaceId: string): Promise<EmbeddingStatus> {
    const enabled = await this.isEnabled(workspaceId);
    const model = await this.settings.embeddingChoice(workspaceId);
    const base: EmbeddingStatus = {
      available: this.available,
      enabled,
      model,
      totalPages: 0,
      indexedPages: 0,
      pendingPages: 0,
      queuedJobs: 0,
      lastIndexedAt: null,
    };
    if (!this.available) return base;

    const total = await this.db
      .selectFrom('pages')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    base.totalPages = Number(total?.count ?? 0);

    if (model) {
      const modelName = nameOf(model);
      const indexed = await this.db
        .selectFrom('pageEmbeddings')
        .select([
          sql<string>`count(distinct page_id)`.as('count'),
          sql<Date | null>`max(updated_at)`.as('last'),
        ])
        .where('workspaceId', '=', workspaceId)
        .where('modelName', '=', modelName)
        .executeTakeFirst();
      base.indexedPages = Number(indexed?.count ?? 0);
      base.lastIndexedAt = indexed?.last ? new Date(indexed.last).toISOString() : null;
      base.pendingPages = (await this.pagesNeedingWork(workspaceId, modelName)).length;
    }
    try {
      // Only work that will add rows; the queue also holds unrelated jobs
      // and the day-delayed cleanup after AI search is switched off.
      const jobs = await this.aiQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized'], 0, 500);
      base.queuedJobs = jobs.filter((job) =>
        job?.data?.workspaceId === workspaceId && INDEXING_JOBS.has(job.name as QueueJob),
      ).length;
    } catch {
      /* queue stats are best effort */
    }
    return base;
  }

  // ---- provider call ------------------------------------------------------

  private async embed(workspaceId: string, texts: string[], choice: ModelChoice): Promise<number[][]> {
    const { embedMany } = await import('ai');
    const model = await this.providers.embeddingModel(workspaceId, choice);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      try {
        const { embeddings } = await embedMany({
          model,
          values: texts.slice(i, i + EMBED_BATCH),
          maxRetries: 2,
        });
        out.push(...embeddings);
      } catch (err: any) {
        throw new BadRequestException(explainEmbeddingError(err, this.logger));
      }
    }
    return out;
  }
}

export function nameOf(choice: ModelChoice): string {
  return `${choice.provider}:${choice.model}`;
}

function pageBody(page: PageRow): string {
  const body = (page.textContent ?? '').trim();
  if (body || !page.content || typeof page.content !== 'object') return body;
  try {
    return jsonToText(page.content as any).trim();
  } catch {
    return '';
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function asObject<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function explainEmbeddingError(err: any, logger: Logger): string {
  const status = err?.statusCode ?? err?.status;
  const message: string = err?.message ?? 'unknown error';
  logger.warn(`Embedding call failed: ${message.slice(0, 300)}`);
  if (status === 401 || status === 403) return 'The embedding provider rejected the API key';
  if (status === 404) return 'The embedding provider does not know this model';
  if (status === 429) return 'The embedding provider is rate limiting requests; try again in a moment';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'Could not reach the embedding provider';
  }
  return `Embedding failed: ${message.split('\n')[0].slice(0, 200)}`;
}
