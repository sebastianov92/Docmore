import { Module } from '@nestjs/common';
import { ImportService } from './services/import.service';
import { ImportController } from './import.controller';
import { StorageModule } from '../storage/storage.module';
import { FileImportTaskService } from './services/file-import-task.service';
import { FileTaskProcessor } from './processors/file-task.processor';
import { ImportAttachmentService } from './services/import-attachment.service';
import { DocumentImportService } from './services/document-import.service';
import { ConfluenceImportService } from './services/confluence-import.service';
import { FileTaskController } from './file-task.controller';
import { PageModule } from '../../core/page/page.module';
import { BaseModule } from '../../core/base/base.module';
import { NotionImportService } from './notion/notion-import.service';
import { NotionImportController } from './notion/notion-import.controller';
import { NotionConnectionService } from './notion/notion-connection.service';

@Module({
  providers: [
    ImportService,
    FileImportTaskService,
    FileTaskProcessor,
    ImportAttachmentService,
    DocumentImportService,
    ConfluenceImportService,
    NotionImportService,
    NotionConnectionService,
  ],
  exports: [ImportService, ImportAttachmentService],
  controllers: [ImportController, FileTaskController, NotionImportController],
  imports: [StorageModule, PageModule, BaseModule],
})
export class ImportModule {}
