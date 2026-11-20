import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { EventName } from '../../../common/events/event.contants';
import { UnfurlService } from '../../integration/unfurl/unfurl.service';
import { BasePropertyType, ConnectedValue } from '../base.schemas';
import { BaseRowUpdatedEvent } from '../events/base-events';

export interface IBaseConnectedFetchJob {
  pageId: string;
  workspaceId: string;
  rowId: string;
  propertyId: string;
  userId: string | null;
}

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const REFRESH_BATCH = 300;

// Connected properties: a cell holds a link to something outside (a pull
// request, an issue, a Drive file, any page) and the server fills in its
// title, status and author through the integrations, as the member who
// pasted it, then refreshes it daily.
@Injectable()
export class BaseConnectedService {
  private readonly logger = new Logger(BaseConnectedService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly rows: BaseRowRepo,
    private readonly properties: BasePropertyRepo,
    private readonly unfurl: UnfurlService,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(QueueName.BASE_QUEUE) private readonly queue: Queue,
  ) {}

  // Cells whose link was just set (no fetchedAt yet) get a fetch.
  async scheduleForCells(pageId: string, workspaceId: string, rowId: string, cells: Record<string, unknown>, userId: string | null) {
    const props = await this.properties.findByPageId(pageId);
    for (const p of props) {
      if (p.type !== BasePropertyType.CONNECTED) continue;
      const v = cells?.[p.id] as ConnectedValue | null | undefined;
      if (!v || typeof v !== 'object' || !v.url || v.fetchedAt) continue;
      await this.schedule({ pageId, workspaceId, rowId, propertyId: p.id, userId: userId ?? v.byUserId ?? null });
    }
  }

  async schedule(job: IBaseConnectedFetchJob) {
    await this.queue.add(QueueJob.BASE_CONNECTED_FETCH, job, {
      jobId: `connected:${job.rowId}:${job.propertyId}:${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
    });
  }

  // The job: ask the integrations about the link and store what came back.
  async fetch(job: IBaseConnectedFetchJob): Promise<void> {
    const row = await this.rows.findById(job.rowId, { workspaceId: job.workspaceId });
    if (!row || row.pageId !== job.pageId) return;
    const current = ((row.cells ?? {}) as Record<string, unknown>)[job.propertyId] as ConnectedValue | null | undefined;
    if (!current || typeof current !== 'object' || !current.url) return;
    const userId = job.userId ?? current.byUserId ?? row.creatorId;
    let next: ConnectedValue;
    try {
      const result = userId ? await this.unfurl.unfurl(current.url, userId, job.workspaceId) : null;
      if (!result) {
        next = { ...current, fetchedAt: new Date().toISOString(), error: 'No details for this link' };
      } else if ('needsConnection' in result && result.needsConnection) {
        next = { ...current, provider: result.integrationType, fetchedAt: new Date().toISOString(), error: `Connect ${result.integrationType} to see details` };
      } else {
        const r = result as any;
        next = {
          url: current.url,
          byUserId: userId ?? null,
          title: r.title ?? null,
          description: r.description ?? null,
          status: r.status ?? null,
          statusColor: r.statusColor ?? null,
          author: r.author ?? null,
          provider: r.provider ?? null,
          providerIcon: r.providerIcon ?? null,
          metadata: r.metadata ?? null,
          fetchedAt: new Date().toISOString(),
          error: null,
        };
      }
    } catch (err: any) {
      this.logger.debug(`connected fetch failed for ${current.url}: ${err?.message}`);
      next = { ...current, fetchedAt: new Date().toISOString(), error: String(err?.message ?? 'Could not fetch').slice(0, 300) };
    }
    const updated = await this.rows.updateCells(row.id, { [job.propertyId]: next }, { pageId: job.pageId, workspaceId: job.workspaceId });
    if (!updated) return;
    // the fetched value carries fetchedAt, so the listener will not loop
    this.eventEmitter.emit(EventName.BASE_ROW_UPDATED, {
      pageId: job.pageId,
      workspaceId: job.workspaceId,
      actorId: null,
      requestId: null,
      rowId: row.id,
      patch: { [job.propertyId]: next },
      updatedCells: { [job.propertyId]: next },
    } satisfies BaseRowUpdatedEvent);
  }

  // Every six hours: links older than a day are fetched again.
  @Interval('base-connected-refresh', 6 * 60 * 60 * 1000)
  async refreshStale(): Promise<void> {
    try {
      const props = await this.db.selectFrom('baseProperties').select(['id', 'pageId', 'workspaceId']).where('type', '=', BasePropertyType.CONNECTED).where('deletedAt', 'is', null).execute();
      let scheduled = 0;
      const cutoff = new Date(Date.now() - REFRESH_AFTER_MS).toISOString();
      for (const p of props) {
        if (scheduled >= REFRESH_BATCH) break;
        const rows = await this.db
          .selectFrom('baseRows')
          .select(['id', 'creatorId'])
          .where('pageId', '=', p.pageId)
          .where('deletedAt', 'is', null)
          .where(sql`cells->${p.id}->>'url'`, 'is not', null)
          .where(sql`coalesce(cells->${p.id}->>'fetchedAt', '1970-01-01')`, '<', cutoff)
          .limit(REFRESH_BATCH - scheduled)
          .execute();
        for (const r of rows) {
          await this.schedule({ pageId: p.pageId, workspaceId: p.workspaceId, rowId: r.id, propertyId: p.id, userId: null });
          scheduled += 1;
        }
      }
      if (scheduled) this.logger.log(`connected properties: ${scheduled} links queued for refresh`);
    } catch (err: any) {
      this.logger.warn(`connected refresh failed: ${err?.message}`);
    }
  }
}
