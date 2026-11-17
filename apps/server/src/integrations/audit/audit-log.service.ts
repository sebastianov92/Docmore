import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ClsService } from 'nestjs-cls';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ActorType,
  AuditEvent,
  AuditLogPayload,
  EXCLUDED_AUDIT_EVENTS,
} from '../../common/events/audit-events';
import {
  AUDIT_CONTEXT_KEY,
  AuditContext,
} from '../../common/middlewares/audit-context.middleware';
import { AuditLogContext, IAuditService } from './audit.service';
import {
  AUDIT_INSERT_CHUNK,
  clampRetentionDays,
  isUuid,
  normalizeIp,
  trimUserAgent,
} from './audit.utils';

// Events a user performs on their own account before or without a
// session; when no actor was set, the subject is the actor.
const SELF_SERVICE_EVENTS = new Set<string>([
  AuditEvent.USER_LOGIN,
  AuditEvent.USER_CREATED,
  AuditEvent.USER_PASSWORD_RESET,
  AuditEvent.USER_PASSWORD_RESET_REQUESTED,
  AuditEvent.USER_MFA_ENABLED,
  AuditEvent.USER_MFA_DISABLED,
  AuditEvent.USER_MFA_BACKUP_CODE_GENERATED,
]);

// Writes the audit rows the rest of the server already emits. Request
// handlers call log() and the actor, workspace and address come from the
// per-request context; background jobs pass the context themselves.
// Writing never blocks or fails the caller: a lost row is logged, not thrown.
@Injectable()
export class AuditLogService implements IAuditService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly cls: ClsService,
  ) {}

  log(payload: AuditLogPayload): void {
    const context = this.requestContext();
    if (!context?.workspaceId) {
      return;
    }
    this.persist([payload], {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? undefined,
      actorType: context.actorType ?? 'user',
      ipAddress: context.ipAddress ?? undefined,
      userAgent: context.userAgent ?? undefined,
    });
  }

  logWithContext(payload: AuditLogPayload, context: AuditLogContext): void {
    this.persist([payload], context);
  }

  logBatchWithContext(payloads: AuditLogPayload[], context: AuditLogContext): void {
    this.persist(payloads, context);
  }

  setActorId(actorId: string): void {
    const context = this.requestContext();
    if (context) {
      context.actorId = actorId;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  setActorType(actorType: ActorType): void {
    const context = this.requestContext();
    if (context) {
      context.actorType = actorType;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  async updateRetention(workspaceId: string, retentionDays: number): Promise<void> {
    await this.db
      .updateTable('workspaces')
      .set({
        auditRetentionDays: clampRetentionDays(retentionDays),
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .execute();
  }

  private requestContext(): AuditContext | undefined {
    try {
      if (!this.cls.isActive()) return undefined;
      return this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private persist(payloads: AuditLogPayload[], context: AuditLogContext): void {
    if (!context?.workspaceId) return;
    const rows = payloads
      .filter((p) => p && p.event && !EXCLUDED_AUDIT_EVENTS.has(p.event))
      .map((p) => this.toRow(p, context));
    if (rows.length === 0) return;

    void this.insertRows(rows).catch((err) => {
      this.logger.warn(`Could not write ${rows.length} audit row(s): ${err?.message}`);
    });
  }

  private async insertRows(rows: Record<string, unknown>[]) {
    for (let i = 0; i < rows.length; i += AUDIT_INSERT_CHUNK) {
      await this.db
        .insertInto('audit')
        .values(rows.slice(i, i + AUDIT_INSERT_CHUNK) as any)
        .execute();
    }
  }

  private toRow(payload: AuditLogPayload, context: AuditLogContext) {
    // resource_id is a uuid column; keep anything else in metadata so the
    // reference is not lost.
    const metadata: Record<string, any> = { ...(payload.metadata ?? {}) };
    let resourceId: string | null = null;
    if (isUuid(payload.resourceId)) {
      resourceId = payload.resourceId;
    } else if (payload.resourceId) {
      metadata.resourceRef = String(payload.resourceId);
    }

    let actorId = isUuid(context.actorId) ? context.actorId : null;
    if (
      !actorId &&
      payload.resourceType === 'user' &&
      SELF_SERVICE_EVENTS.has(payload.event) &&
      isUuid(payload.resourceId)
    ) {
      actorId = payload.resourceId;
    }

    return {
      workspaceId: context.workspaceId,
      actorId,
      actorType: context.actorType ?? 'user',
      event: payload.event,
      resourceType: payload.resourceType,
      resourceId,
      spaceId: isUuid(payload.spaceId) ? payload.spaceId : null,
      // Plain objects: the pg driver serializes them for the jsonb columns,
      // the way every other jsonb write in this codebase does it.
      changes: payload.changes ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      ipAddress: normalizeIp(context.ipAddress),
      userAgent: trimUserAgent(context.userAgent),
    };
  }
}
