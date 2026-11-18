import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  QueueJob,
  QueueName,
} from '../../../integrations/queue/constants/queue.constants';
import { IBaseCsvImportJob } from '../../../integrations/queue/constants/queue.interface';
import { BaseCsvImportService } from '../import/base-csv-import.service';

@Processor(QueueName.BASE_IMPORT_QUEUE)
export class BaseImportProcessor extends WorkerHost {
  private readonly logger = new Logger(BaseImportProcessor.name);

  constructor(private readonly csvImportService: BaseCsvImportService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== QueueJob.BASE_CSV_IMPORT) {
      this.logger.warn(`unknown job ${job.name} on the base import queue`);
      return;
    }
    const data = job.data as IBaseCsvImportJob;
    await this.csvImportService.run(data.fileTaskId);
  }
}
