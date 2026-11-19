import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Inject,
  Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { AuditQueryService } from './audit-query.service';
import { AuditLogService } from './audit-log.service';
import { AuditListDto, UpdateAuditRetentionDto } from './dto/audit.dto';
import { DEFAULT_AUDIT_RETENTION_DAYS } from './audit.utils';
import { stringify } from 'csv-stringify/sync';
import { FastifyReply } from 'fastify';
import {  AUDIT_SERVICE,  IAuditService, } from './audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';

// The trail records what admins do too, so only the workspace owner reads
// it or changes how long it is kept.
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditQueryService: AuditQueryService,
    private readonly auditLogService: AuditLogService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() dto: AuditListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user);
    return this.auditQueryService.list(workspace.id, dto);
  }

  // CSV of the filtered log (same filters as the list), owners only.
  @HttpCode(HttpStatus.OK)
  @Post('export')
  async exportCsv(
    @Body() dto: AuditListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    this.assertOwner(user);
    const rows = await this.auditQueryService.exportRows(workspace.id, dto);
    const records = rows.map((row: any) => ({
      time: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ''),
      event: row.event,
      actor_name: row.actor?.name ?? '',
      actor_email: row.actor?.email ?? '',
      actor_type: row.actorType ?? '',
      resource_type: row.resourceType ?? '',
      resource: row.resource?.title ?? row.resource?.name ?? row.resource?.email ?? '',
      resource_id: row.resourceId ?? '',
      space_id: row.spaceId ?? '',
      ip: row.ipAddress ?? '',
      user_agent: row.userAgent ?? '',
      changes: row.changes ? JSON.stringify(row.changes) : '',
      metadata: row.metadata ? JSON.stringify(row.metadata) : '',
    }));
    const csv = stringify(records, { header: true, bom: true });
    this.auditService.log({
      event: AuditEvent.AUDIT_EXPORTED,
      resourceType: AuditResource.WORKSPACE,
      resourceId: workspace.id,
      metadata: { rows: records.length, filters: dto },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`)
      .send(csv);
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention')
  async retention(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    const days = await this.auditQueryService.retentionDays(workspace.id);
    return { retentionDays: days ?? DEFAULT_AUDIT_RETENTION_DAYS };
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention/update')
  async updateRetention(
    @Body() dto: UpdateAuditRetentionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user);
    await this.auditLogService.updateRetention(workspace.id, dto.auditRetentionDays);
    const days = await this.auditQueryService.retentionDays(workspace.id);
    return { retentionDays: days ?? DEFAULT_AUDIT_RETENTION_DAYS };
  }

  private assertOwner(user: User) {
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException('Only the workspace owner can view audit logs');
    }
  }
}
