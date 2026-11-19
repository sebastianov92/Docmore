import { Body, Controller, HttpCode, HttpStatus, Inject, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BaseHistoryService } from '../services/base-history.service';
import { ListHistoryDto, RestoreDeletedDto, RestoreVersionDto } from '../dto/history.dto';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';

// Cell history of a base: what changed, by whom, and a way back.
@UseGuards(JwtAuthGuard)
@Controller('bases/history')
export class BaseHistoryController {
  constructor(
    private readonly history: BaseHistoryService,
    private readonly baseRepo: BaseRepo,
    private readonly pageAccessService: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post()
  async list(@Body() dto: ListHistoryDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) throw new NotFoundException('Base not found');
    await this.pageAccessService.validateCanView(base, user);
    return this.history.list({ pageId: dto.pageId, workspaceId: workspace.id, rowId: dto.rowId, before: dto.before, limit: dto.limit });
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('restore')
  async restore(@Body() dto: RestoreVersionDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) throw new NotFoundException('Base not found');
    await this.pageAccessService.validateCanEdit(base, user);
    const result = await this.history.restore(dto.versionId, dto.pageId, workspace.id, user.id);
    this.auditService.log({
      event: AuditEvent.BASE_ROW_RESTORED,
      resourceType: AuditResource.BASE,
      resourceId: base.id,
      spaceId: base.spaceId,
      metadata: { versionId: dto.versionId, rowId: result.row.id, undeleted: result.restoredDeleted },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('restore-deleted')
  async restoreDeleted(@Body() dto: RestoreDeletedDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) throw new NotFoundException('Base not found');
    await this.pageAccessService.validateCanEdit(base, user);
    const result = await this.history.restoreDeleted(dto.pageId, workspace.id, new Date(dto.since), user.id);
    this.auditService.log({
      event: AuditEvent.BASE_ROWS_RESTORED,
      resourceType: AuditResource.BASE,
      resourceId: base.id,
      spaceId: base.spaceId,
      metadata: { since: dto.since, count: result.count },
    });
    return result;
  }
}
