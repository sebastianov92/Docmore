import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { AiEmbeddingService } from './embeddings/ai-embedding.service';
import { AiBaseFillService } from './base-fill/ai-base-fill.service';
import { AiResearchService } from './research/ai-research.service';
import { AiMeetingService } from './meetings/ai-meeting.service';

// Drains the AI queue that pages, spaces and workspaces already feed: keeps
// page embeddings current, drops them with their pages, and runs the
// per-workspace backfill and reset.
@Processor(QueueName.AI_QUEUE, { concurrency: 2 })
export class AiProcessor extends WorkerHost {
  private readonly logger = new Logger(AiProcessor.name);

  constructor(
    private readonly embeddings: AiEmbeddingService,
    private readonly baseFill: AiBaseFillService,
    private readonly research: AiResearchService,
    private readonly meetings: AiMeetingService,
  ) {
    super();
  }

  async process(job: Job<any, void>): Promise<void> {
    const { pageIds, workspaceId, spaceId } = job.data ?? {};
    switch (job.name) {
      case QueueJob.PAGE_CREATED:
      case QueueJob.PAGE_RESTORED:
      case QueueJob.PAGE_MOVED_TO_SPACE:
        return this.embeddings.scheduleIndex(pageIds, workspaceId, 2_000);
      case QueueJob.PAGE_CONTENT_UPDATED:
      case QueueJob.PAGE_UPDATED:
        return this.embeddings.scheduleIndex(pageIds, workspaceId);
      case QueueJob.GENERATE_PAGE_EMBEDDINGS:
        return this.embeddings.indexPages(pageIds, workspaceId);
      case QueueJob.PAGE_SOFT_DELETED:
      case QueueJob.PAGE_DELETED:
      case QueueJob.DELETE_PAGE_EMBEDDINGS:
        return this.embeddings.deleteForPages(pageIds);
      case QueueJob.SPACE_DELETED:
        return this.embeddings.deleteForSpace(spaceId);
      case QueueJob.WORKSPACE_DELETED:
        return this.embeddings.deleteForWorkspace(workspaceId);
      case QueueJob.WORKSPACE_DELETE_EMBEDDINGS:
        // Queued a day after AI search is switched off; a workspace that
        // switched it back on in the meantime keeps its index.
        if (await this.embeddings.isEnabled(workspaceId)) return;
        return this.embeddings.deleteForWorkspace(workspaceId);
      case QueueJob.WORKSPACE_CREATE_EMBEDDINGS:
        return this.embeddings.backfill(workspaceId);
      case QueueJob.WORKSPACE_RESET_EMBEDDINGS:
        return this.embeddings.backfill(workspaceId, { reset: true });
      case QueueJob.BASE_AI_FILL:
        return this.baseFill.process(job.data);
      case QueueJob.AI_RESEARCH:
        return this.research.process(job.data);
      case QueueJob.AI_MEETING_NOTES:
        return this.meetings.process(job.data);
      default:
        return;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    this.logger.warn(
      `AI job ${job?.name ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'}): ${err?.message}`,
    );
  }
}
