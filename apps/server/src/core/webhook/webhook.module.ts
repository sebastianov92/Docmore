import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueName } from '../../integrations/queue/constants';
import { WebhookService } from './webhook.service';
import { WebhookListener } from './webhook.listener';
import { WebhookProcessor } from './webhook.processor';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [BullModule.registerQueue({ name: QueueName.WEBHOOK_QUEUE })],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookListener, WebhookProcessor],
  exports: [WebhookService],
})
export class WebhookModule {}
