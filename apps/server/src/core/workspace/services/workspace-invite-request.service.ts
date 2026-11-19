import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceInvitationService } from './workspace-invitation.service';
import { InviteUserRole } from '../../../common/helpers/types/permission';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { sql } from 'kysely';

// Members ask admins to invite someone; approving sends the real invitation.
@Injectable()
export class WorkspaceInviteRequestService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly invitationService: WorkspaceInvitationService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async create(user: User, workspace: Workspace, emails: string[], note?: string) {
    const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
    const members = await this.db
      .selectFrom('users')
      .select('email')
      .where('workspaceId', '=', workspace.id)
      .where('email', 'in', wanted)
      .execute();
    const existing = new Set(members.map((m) => m.email.toLowerCase()));
    const pending = await this.db
      .selectFrom('workspaceInviteRequests')
      .select('email')
      .where('workspaceId', '=', workspace.id)
      .where('status', '=', 'pending')
      .where(sql`lower(email)`, 'in', wanted)
      .execute();
    const alreadyPending = new Set(pending.map((p) => p.email.toLowerCase()));
    const toInsert = wanted.filter((e) => !existing.has(e) && !alreadyPending.has(e));
    if (toInsert.length > 0) {
      await this.db
        .insertInto('workspaceInviteRequests')
        .values(
          toInsert.map((email) => ({
            workspaceId: workspace.id,
            requesterId: user.id,
            email,
            note: note?.trim() || null,
          })),
        )
        .execute();
      this.auditService.log({
        event: AuditEvent.WORKSPACE_INVITE_REQUESTED,
        resourceType: AuditResource.WORKSPACE,
        resourceId: workspace.id,
        metadata: { emails: toInsert },
      });
    }
    return {
      requested: toInsert,
      skipped: wanted.filter((e) => existing.has(e) || alreadyPending.has(e)),
    };
  }

  async listPending(workspaceId: string) {
    const items = await this.db
      .selectFrom('workspaceInviteRequests')
      .innerJoin('users', 'users.id', 'workspaceInviteRequests.requesterId')
      .select([
        'workspaceInviteRequests.id',
        'workspaceInviteRequests.email',
        'workspaceInviteRequests.note',
        'workspaceInviteRequests.createdAt',
        'users.id as requesterId',
        'users.name as requesterName',
        'users.avatarUrl as requesterAvatarUrl',
      ])
      .where('workspaceInviteRequests.workspaceId', '=', workspaceId)
      .where('workspaceInviteRequests.status', '=', 'pending')
      .orderBy('workspaceInviteRequests.createdAt', 'asc')
      .execute();
    return { items };
  }

  async listMine(userId: string, workspaceId: string) {
    const items = await this.db
      .selectFrom('workspaceInviteRequests')
      .select(['id', 'email', 'note', 'status', 'createdAt', 'reviewedAt'])
      .where('workspaceId', '=', workspaceId)
      .where('requesterId', '=', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .execute();
    return { items };
  }

  async review(reviewer: User, workspace: Workspace, requestId: string, approve: boolean) {
    const request = await this.db
      .selectFrom('workspaceInviteRequests')
      .selectAll()
      .where('id', '=', requestId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'pending') {
      throw new BadRequestException('Request already reviewed');
    }
    if (approve) {
      await this.invitationService.createInvitation(
        { emails: [request.email], role: InviteUserRole.MEMBER, groupIds: [] } as any,
        workspace,
        reviewer,
      );
    }
    await this.db
      .updateTable('workspaceInviteRequests')
      .set({
        status: approve ? 'approved' : 'rejected',
        reviewedById: reviewer.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', requestId)
      .execute();
    this.auditService.log({
      event: approve
        ? AuditEvent.WORKSPACE_INVITE_REQUEST_APPROVED
        : AuditEvent.WORKSPACE_INVITE_REQUEST_REJECTED,
      resourceType: AuditResource.WORKSPACE,
      resourceId: workspace.id,
      metadata: { requestId, email: request.email },
    });
    return { status: approve ? 'approved' : 'rejected' };
  }
}
