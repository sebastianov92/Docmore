import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { User } from '@docmost/db/types/entity.types';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { PageAccessService } from '../../../core/page/page-access/page-access.service';
import { StorageService } from '../../storage/storage.service';
import { AUDIT_SERVICE, IAuditService } from '../../audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { getPageTitle } from '../../../common/helpers';
import { FileTaskStatus } from '../../import/utils/file.utils';
import { PDF_EXPORT_SOURCE, PdfExportService } from './pdf-export.service';
import { PdfDownloadDto, PdfRenderDto, StartPdfExportDto } from './dto/pdf-export.dto';

@Controller('pdf-export')
export class PdfExportController {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pdfExport: PdfExportService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly storage: StorageService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  // Starts the export; the client polls /file-tasks/info and then downloads.
  @UseGuards(JwtAuthGuard)
  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post()
  async start(@Body() dto: StartPdfExportDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccess.validateCanView(page, user);
    await this.pageAccess.validateCanExport(page.spaceId, page.workspaceId);
    const result = await this.pdfExport.start(page, user);
    this.audit.log({
      event: AuditEvent.PAGE_EXPORTED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { title: getPageTitle(page.title), format: 'pdf', spaceId: page.spaceId },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('config')
  async config() {
    return { enabled: this.pdfExport.isConfigured() };
  }

  // Called by the render page inside Chromium; the token is the credential.
  @HttpCode(HttpStatus.OK)
  @Post('render')
  async render(@Body() dto: PdfRenderDto) {
    return this.pdfExport.renderData(dto.pageId, dto.token);
  }

  // Embedded files for the render run, keyed by the same token.
  @Get('files/:token/:fileId/:fileName')
  async file(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const attachment = await this.pdfExport.fileForRender(token, fileId);
    const stream = await this.storage.readStream(attachment.filePath);
    res.headers({
      'Content-Type': attachment.mimeType || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
    });
    return res.send(stream);
  }

  // The finished PDF, for whoever may read the page.
  @UseGuards(JwtAuthGuard)
  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('download')
  async download(@Body() dto: PdfDownloadDto, @AuthUser() user: User, @Res() res: FastifyReply) {
    const task = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', dto.fileTaskId)
      .where('source', '=', PDF_EXPORT_SOURCE)
      .executeTakeFirst();
    if (!task || !task.pageId) {
      throw new NotFoundException('Export not found');
    }
    if (task.status !== FileTaskStatus.Success) {
      throw new NotFoundException(task.status === FileTaskStatus.Failed ? 'The export failed' : 'The export is not ready yet');
    }
    const page = await this.pageRepo.findById(task.pageId);
    if (!page) throw new NotFoundException('Page not found');
    if (task.creatorId !== user.id) {
      await this.pageAccess.validateCanView(page, user);
      if (!(await this.pagePermissionRepo.canUserAccessPage(user.id, page.id))) {
        throw new ForbiddenException();
      }
    }
    const stream = await this.storage.readStream(task.filePath);
    res.headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(task.fileName) + '"',
    });
    return res.send(stream);
  }
}
