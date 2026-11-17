import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import { PageIndexService } from './page-index.service';
import { TypesenseService } from './typesense.service';

// Drains the search queue the page, space and workspace listeners feed.
// With the Postgres driver the jobs are acknowledged and ignored.
@Processor(QueueName.SEARCH_QUEUE)
export class SearchQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(SearchQueueProcessor.name);

  constructor(
    private readonly typesense: TypesenseService,
    private readonly index: PageIndexService,
  ) {
    super();
  }

  async process(job: Job<any, void>): Promise<void> {
    if (!this.typesense.enabled) return;
    const { pageIds, spaceId, workspaceId } = job.data ?? {};
    switch (job.name) {
      case QueueJob.PAGE_CREATED:
      case QueueJob.PAGE_UPDATED:
      case QueueJob.PAGE_RESTORED:
        return this.index.scheduleIndex(pageIds ?? []);
      case QueueJob.SEARCH_INDEX_PAGE:
        return this.index.indexPages(pageIds ?? []);
      case QueueJob.PAGE_DELETED:
      case QueueJob.PAGE_SOFT_DELETED:
      case QueueJob.SEARCH_REMOVE_PAGE:
        return this.index.removePages(pageIds ?? []);
      case QueueJob.SPACE_DELETED:
        return this.index.removeSpace(spaceId);
      case QueueJob.WORKSPACE_DELETED:
        return this.index.removeWorkspace(workspaceId);
      case QueueJob.SEARCH_INDEX_PAGES:
        await this.index.backfill(workspaceId);
        return;
      default:
        return;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    this.logger.warn(`Search index job ${job?.name ?? '?'} failed: ${err?.message}`);
  }
}
