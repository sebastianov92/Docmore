import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
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

// The trail records what admins do too, so only the workspace owner reads
// it or changes how long it is kept.
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditQueryService: AuditQueryService,
    private readonly auditLogService: AuditLogService,
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
