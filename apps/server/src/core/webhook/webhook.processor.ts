import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { WebhookJob, WebhookService } from './webhook.service';

@Processor(QueueName.WEBHOOK_QUEUE, { concurrency: 4 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly webhooks: WebhookService) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    if (job.name !== QueueJob.WEBHOOK_DELIVER) return;
    await this.webhooks.deliver(job.data, job.attemptsMade + 1);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    this.logger.debug(`webhook delivery ${job?.data?.deliveryId ?? '?'} attempt ${job?.attemptsMade ?? '?'} failed: ${err?.message}`);
  }
}
