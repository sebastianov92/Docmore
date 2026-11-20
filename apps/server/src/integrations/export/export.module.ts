import { Module } from '@nestjs/common';
import { CaslModule } from '../../core/casl/casl.module';
import { PageAccessModule } from '../../core/page/page-access/page-access.module';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { StorageModule } from '../storage/storage.module';
import { DocxExportService } from './docx-export.service';
import { DocxExportController } from './docx-export.controller';
import { PdfExportService } from './pdf/pdf-export.service';
import { PdfExportController } from './pdf/pdf-export.controller';
import { TokenModule } from '../../core/auth/token.module';

@Module({
  imports: [StorageModule, TokenModule, CaslModule, PageAccessModule],
  providers: [ExportService, DocxExportService, PdfExportService],
  controllers: [ExportController, DocxExportController, PdfExportController],
  exports: [PdfExportService],
})
export class ExportModule {}
