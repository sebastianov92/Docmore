import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE, NoopAuditService } from './audit.service';
import { AuditLogService } from './audit-log.service';
import { AuditQueryService } from './audit-query.service';
import { AuditCleanupService } from './audit-cleanup.service';
import { AuditController } from './audit.controller';

// Docmore's audit trail: every module that injects AUDIT_SERVICE writes
// real rows, the owner reads them under Settings > Audit logs, and a daily
// sweep applies the workspace's retention.
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditLogService,
    AuditQueryService,
    AuditCleanupService,
    {
      provide: AUDIT_SERVICE,
      useExisting: AuditLogService,
    },
  ],
  exports: [AUDIT_SERVICE, AuditLogService, AuditQueryService],
})
export class AuditModule {}

// Kept for builds that bundle the enterprise audit module instead.
@Global()
@Module({
  providers: [
    {
      provide: AUDIT_SERVICE,
      useClass: NoopAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class NoopAuditModule {}
