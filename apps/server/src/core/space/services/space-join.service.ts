import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberService } from './space-member.service';
import { SpaceRole, SpaceVisibility } from '../../../common/helpers/types/permission';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { sql } from 'kysely';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';

// Open spaces: any member joins. Closed spaces: a member asks, a space
// admin approves. Private spaces stay out of the directory.
@Injectable()
export class SpaceJoinService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceMemberService: SpaceMemberService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  // Spaces the user could join: open or closed, active, not a member yet.
  async browse(user: User, workspaceId: string, pagination: PaginationOptions) {
    let query = this.db
      .selectFrom('spaces')
      .select([
        'spaces.id',
        'spaces.name',
        'spaces.slug',
        'spaces.description',
        'spaces.logo',
        'spaces.visibility',
        'spaces.createdAt',
      ])
      .select((eb) =>
        eb
          .selectFrom('spaceMembers')
          .select(sql<number>`count(*)`.as('n'))
          .whereRef('spaceMembers.spaceId', '=', 'spaces.id')
          .as('memberCount'),
      )
      .select((eb) =>
        eb
          .selectFrom('spaceJoinRequests')
          .select('spaceJoinRequests.id')
          .whereRef('spaceJoinRequests.spaceId', '=', 'spaces.id')
          .where('spaceJoinRequests.userId', '=', user.id)
          .where('spaceJoinRequests.status', '=', 'pending')
          .limit(1)
          .as('pendingRequestId'),
      )
      .where('spaces.workspaceId', '=', workspaceId)
      .where('spaces.deletedAt', 'is', null)
      .where('spaces.archivedAt', 'is', null)
      .where('spaces.isPersonal', '=', false)
      .where('spaces.visibility', 'in', [SpaceVisibility.OPEN, SpaceVisibility.CLOSED])
      .where('spaces.id', 'not in', this.spaceMemberRepo.getUserSpaceIdsQuery(user.id));

    if (pagination.query) {
      query = query.where((eb) =>
        eb(sql`f_unaccent(spaces.name)`, 'ilike', sql`f_unaccent(${'%' + pagination.query + '%'})`),
      );
    }

    const result = await executeWithCursorPagination(query as any, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'name', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({ name: cursor.name, id: cursor.id }),
    } as any);
    return {
      ...result,
      items: (result.items as any[]).map((row) => ({
        ...row,
        memberCount: Number(row.memberCount ?? 0),
        requested: Boolean(row.pendingRequestId),
        pendingRequestId: undefined,
      })),
    };
  }

  private async loadJoinable(spaceId: string, workspaceId: string) {
    const space = await this.spaceRepo.findById(spaceId, workspaceId);
    if (!space || space.deletedAt || space.archivedAt) {
      throw new NotFoundException('Space not found');
    }
    return space;
  }

  async join(user: User, workspace: Workspace, spaceId: string) {
    const space = await this.loadJoinable(spaceId, workspace.id);
    if (space.visibility !== SpaceVisibility.OPEN) {
      throw new ForbiddenException('This space is not open to join');
    }
    const roles = await this.spaceMemberRepo.getUserRolesForSpaces(user.id, [spaceId]);
    if (roles.length > 0) return { joined: true, role: roles[0].role };
    const role = space.defaultRole || SpaceRole.WRITER;
    await this.spaceMemberService.addUserToSpace(user.id, spaceId, role, workspace.id);
    this.auditService.log({
      event: AuditEvent.SPACE_JOINED,
      resourceType: AuditResource.SPACE,
      resourceId: spaceId,
      spaceId,
      metadata: { role },
    });
    return { joined: true, role };
  }

  async request(user: User, workspace: Workspace, spaceId: string, note?: string) {
    const space = await this.loadJoinable(spaceId, workspace.id);
    if (space.visibility !== SpaceVisibility.CLOSED) {
      throw new ForbiddenException('This space does not take join requests');
    }
    const roles = await this.spaceMemberRepo.getUserRolesForSpaces(user.id, [spaceId]);
    if (roles.length > 0) throw new BadRequestException('You are already a member');
    const existing = await this.db
      .selectFrom('spaceJoinRequests')
      .select('id')
      .where('spaceId', '=', spaceId)
      .where('userId', '=', user.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (existing) return { requested: true, id: existing.id };
    const created = await this.db
      .insertInto('spaceJoinRequests')
      .values({ spaceId, userId: user.id, workspaceId: workspace.id, note: note?.trim() || null })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    this.auditService.log({
      event: AuditEvent.SPACE_JOIN_REQUESTED,
      resourceType: AuditResource.SPACE,
      resourceId: spaceId,
      spaceId,
      metadata: { requestId: created.id },
    });
    return { requested: true, id: created.id };
  }

  async listPending(spaceId: string, workspaceId: string) {
    const items = await this.db
      .selectFrom('spaceJoinRequests')
      .innerJoin('users', 'users.id', 'spaceJoinRequests.userId')
      .select([
        'spaceJoinRequests.id',
        'spaceJoinRequests.note',
        'spaceJoinRequests.createdAt',
        'users.id as userId',
        'users.name',
        'users.email',
        'users.avatarUrl',
      ])
      .where('spaceJoinRequests.spaceId', '=', spaceId)
      .where('spaceJoinRequests.workspaceId', '=', workspaceId)
      .where('spaceJoinRequests.status', '=', 'pending')
      .orderBy('spaceJoinRequests.createdAt', 'asc')
      .execute();
    return { items };
  }

  async pendingCount(spaceId: string, workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom('spaceJoinRequests')
      .select(sql<number>`count(*)`.as('n'))
      .where('spaceId', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async findRequest(requestId: string, workspaceId: string) {
    const request = await this.db
      .selectFrom('spaceJoinRequests')
      .selectAll()
      .where('id', '=', requestId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!request) throw new NotFoundException('Request not found');
    return request;
  }

  async review(reviewer: User, workspace: Workspace, requestId: string, approve: boolean) {
    const request = await this.findRequest(requestId, workspace.id);
    if (request.status !== 'pending') {
      throw new BadRequestException('Request already reviewed');
    }
    const space = await this.loadJoinable(request.spaceId, workspace.id);
    if (approve) {
      const roles = await this.spaceMemberRepo.getUserRolesForSpaces(request.userId, [space.id]);
      if (roles.length === 0) {
        await this.spaceMemberService.addUserToSpace(
          request.userId,
          space.id,
          space.defaultRole || SpaceRole.WRITER,
          workspace.id,
        );
      }
    }
    await this.db
      .updateTable('spaceJoinRequests')
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
        ? AuditEvent.SPACE_JOIN_REQUEST_APPROVED
        : AuditEvent.SPACE_JOIN_REQUEST_REJECTED,
      resourceType: AuditResource.SPACE,
      resourceId: space.id,
      spaceId: space.id,
      metadata: { requestId, userId: request.userId },
    });
    return { status: approve ? 'approved' : 'rejected' };
  }
}
