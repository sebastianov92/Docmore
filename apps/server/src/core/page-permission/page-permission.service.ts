import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { Page, User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { PageAccessService } from '../page/page-access/page-access.service';
import {
  PageAccessLevel,
  PagePermissionRole,
} from '../../common/helpers/types/permission';
import { WsService } from '../../ws/ws.service';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { IPermissionGrantedNotificationJob } from '../../integrations/queue/constants/queue.interface';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  UpdatePagePermissionDto,
} from './dto/page-permission.dto';

export type PageRestrictionInfo = {
  restrictionId?: string;
  hasDirectRestriction: boolean;
  hasInheritedRestriction: boolean;
  inheritedFrom?: { id: string; slugId: string; title: string | null };
  userAccess: { canView: boolean; canEdit: boolean; canManage: boolean };
};

type Access = {
  hasDirectRestriction: boolean;
  hasInheritedRestriction: boolean;
  canEdit: boolean;
  canManage: boolean;
};

@Injectable()
export class PagePermissionService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly wsService: WsService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getPage(pageId: string, workspaceId: string): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    return page;
  }

  async getRestrictionInfo(
    user: User,
    page: Page,
  ): Promise<PageRestrictionInfo> {
    const access = await this.resolveAccess(user, page);
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );

    let inheritedFrom: PageRestrictionInfo['inheritedFrom'];
    if (access.hasInheritedRestriction) {
      inheritedFrom = await this.nearestRestrictedAncestor(page.id);
    }

    return {
      restrictionId: pageAccess?.id,
      hasDirectRestriction: access.hasDirectRestriction,
      hasInheritedRestriction: access.hasInheritedRestriction,
      inheritedFrom,
      userAccess: {
        canView: true,
        canEdit: access.canEdit,
        canManage: access.canManage,
      },
    };
  }

  // Restricting keeps the actor as a writer so nobody locks themselves out.
  async restrict(user: User, page: Page): Promise<void> {
    await this.assertCanManage(user, page);

    const existing = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (existing) {
      return;
    }

    await executeTx(this.db, async (trx) => {
      const pageAccess = await this.pagePermissionRepo.insertPageAccess(
        {
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          accessLevel: PageAccessLevel.RESTRICTED,
          creatorId: user.id,
        },
        trx,
      );
      await this.pagePermissionRepo.insertPagePermissions(
        [
          {
            pageAccessId: pageAccess.id,
            userId: user.id,
            role: PagePermissionRole.WRITER,
            addedById: user.id,
          },
        ],
        trx,
      );
    });

    this.auditService.log({
      event: AuditEvent.PAGE_RESTRICTED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { title: page.title },
    });
    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  async removeRestriction(user: User, page: Page): Promise<void> {
    await this.assertCanManage(user, page);

    const existing = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!existing) {
      return;
    }

    await this.pagePermissionRepo.deletePageAccess(page.id);

    this.auditService.log({
      event: AuditEvent.PAGE_RESTRICTION_REMOVED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { title: page.title },
    });
    await this.wsService.invalidateSpaceRestrictionCache(page.spaceId);
  }

  async list(user: User, page: Page, pagination: PaginationOptions) {
    await this.pageAccessService.validateCanView(page, user);

    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!pageAccess) {
      return emptyCursorPaginationResult(pagination.limit);
    }
    return this.pagePermissionRepo.getPagePermissionsPaginated(
      pageAccess.id,
      pagination,
    );
  }

  // New people are added; people already listed get the new role instead.
  async add(user: User, page: Page, dto: AddPagePermissionDto): Promise<void> {
    await this.assertCanManage(user, page);
    const pageAccess = await this.requireDirectRestriction(page);

    const userIds = await this.workspaceUserIds(
      unique(dto.userIds),
      page.workspaceId,
    );
    const groupIds = await this.workspaceGroupIds(
      unique(dto.groupIds),
      page.workspaceId,
    );
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('Choose at least one person or group');
    }

    const current = await this.db
      .selectFrom('pagePermissions')
      .select(['userId', 'groupId', 'role'])
      .where('pageAccessId', '=', pageAccess.id)
      .execute();
    const currentUsers = new Map(
      current.filter((row) => row.userId).map((row) => [row.userId, row.role]),
    );
    const currentGroups = new Map(
      current.filter((row) => row.groupId).map((row) => [row.groupId, row.role]),
    );

    const newUserIds = userIds.filter((id) => !currentUsers.has(id));
    const newGroupIds = groupIds.filter((id) => !currentGroups.has(id));

    await executeTx(this.db, async (trx) => {
      await this.pagePermissionRepo.insertPagePermissions(
        [
          ...newUserIds.map((userId) => ({
            pageAccessId: pageAccess.id,
            userId,
            role: dto.role,
            addedById: user.id,
          })),
          ...newGroupIds.map((groupId) => ({
            pageAccessId: pageAccess.id,
            groupId,
            role: dto.role,
            addedById: user.id,
          })),
        ],
        trx,
      );

      for (const userId of userIds) {
        if (currentUsers.has(userId) && currentUsers.get(userId) !== dto.role) {
          await this.pagePermissionRepo.updatePagePermissionRole(
            pageAccess.id,
            dto.role,
            { userId },
            trx,
          );
        }
      }
      for (const groupId of groupIds) {
        if (currentGroups.has(groupId) && currentGroups.get(groupId) !== dto.role) {
          await this.pagePermissionRepo.updatePagePermissionRole(
            pageAccess.id,
            dto.role,
            { groupId },
            trx,
          );
        }
      }
    });

    await this.assertStillHasWriter(pageAccess.id);

    this.auditService.log({
      event: AuditEvent.PAGE_PERMISSION_ADDED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { role: dto.role, userIds, groupIds },
    });

    const toNotify = newUserIds.filter((id) => id !== user.id);
    if (toNotify.length > 0) {
      const job: IPermissionGrantedNotificationJob = {
        userIds: toNotify,
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        actorId: user.id,
        role: dto.role,
      };
      await this.notificationQueue.add(QueueJob.PAGE_PERMISSION_GRANTED, job);
    }
  }

  async updateRole(
    user: User,
    page: Page,
    dto: UpdatePagePermissionDto,
  ): Promise<void> {
    await this.assertCanManage(user, page);
    const pageAccess = await this.requireDirectRestriction(page);

    const target = dto.userId
      ? await this.pagePermissionRepo.findPagePermissionByUserId(
          pageAccess.id,
          dto.userId,
        )
      : await this.pagePermissionRepo.findPagePermissionByGroupId(
          pageAccess.id,
          dto.groupId,
        );
    if (!target) {
      throw new NotFoundException('That person does not have access yet');
    }
    if (target.role === dto.role) {
      return;
    }

    if (
      target.role === PagePermissionRole.WRITER &&
      (await this.pagePermissionRepo.countWritersByPageAccessId(pageAccess.id)) <= 1
    ) {
      throw new BadRequestException(
        'Keep at least one person who can edit this page',
      );
    }

    await this.pagePermissionRepo.updatePagePermissionRole(
      pageAccess.id,
      dto.role,
      dto.userId ? { userId: dto.userId } : { groupId: dto.groupId },
    );

    this.auditService.log({
      event: AuditEvent.PAGE_PERMISSION_ROLE_CHANGED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: {
        role: dto.role,
        previousRole: target.role,
        userId: dto.userId,
        groupId: dto.groupId,
      },
    });
  }

  async remove(
    user: User,
    page: Page,
    dto: RemovePagePermissionDto,
  ): Promise<void> {
    await this.assertCanManage(user, page);
    const pageAccess = await this.requireDirectRestriction(page);

    const userIds = unique(dto.userIds);
    const groupIds = unique(dto.groupIds);
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('Choose at least one person or group');
    }

    const rows = await this.db
      .selectFrom('pagePermissions')
      .select(['userId', 'groupId', 'role'])
      .where('pageAccessId', '=', pageAccess.id)
      .execute();
    const writersLeft = rows.filter(
      (row) =>
        row.role === PagePermissionRole.WRITER &&
        !(row.userId && userIds.includes(row.userId)) &&
        !(row.groupId && groupIds.includes(row.groupId)),
    ).length;
    if (writersLeft === 0) {
      throw new BadRequestException(
        'Keep at least one person who can edit this page',
      );
    }

    await executeTx(this.db, async (trx) => {
      await this.pagePermissionRepo.deletePagePermissionsByUserIds(
        pageAccess.id,
        userIds,
        trx,
      );
      await this.pagePermissionRepo.deletePagePermissionsByGroupIds(
        pageAccess.id,
        groupIds,
        trx,
      );
    });

    this.auditService.log({
      event: AuditEvent.PAGE_PERMISSION_REMOVED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { userIds, groupIds },
    });
  }

  // Space admins and anyone who can edit the page may change who has access.
  private async resolveAccess(user: User, page: Page): Promise<Access> {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const level = await this.pagePermissionRepo.getUserPageAccessLevel(
      user.id,
      page.id,
    );
    if (level.hasAnyRestriction && !level.canAccess) {
      throw new ForbiddenException();
    }

    const isSpaceAdmin = ability.can(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    const canEdit = level.hasAnyRestriction
      ? level.canEdit
      : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page);

    return {
      hasDirectRestriction: level.hasDirectRestriction,
      hasInheritedRestriction: level.hasInheritedRestriction,
      canEdit,
      canManage: isSpaceAdmin || canEdit,
    };
  }

  private async assertCanManage(user: User, page: Page): Promise<void> {
    const access = await this.resolveAccess(user, page);
    if (!access.canManage) {
      throw new ForbiddenException(
        'Only people who can edit this page may change its access',
      );
    }
  }

  private async requireDirectRestriction(page: Page) {
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!pageAccess) {
      throw new BadRequestException('Restrict the page before managing access');
    }
    return pageAccess;
  }

  private async assertStillHasWriter(pageAccessId: string): Promise<void> {
    const writers =
      await this.pagePermissionRepo.countWritersByPageAccessId(pageAccessId);
    if (writers === 0) {
      throw new BadRequestException(
        'Keep at least one person who can edit this page',
      );
    }
  }

  private async nearestRestrictedAncestor(pageId: string) {
    const { rows } = await sql<{ id: string; slugId: string; title: string | null }>`
      WITH RECURSIVE ancestors AS (
        SELECT pages.parent_page_id AS ancestor_id, 1 AS depth
        FROM pages WHERE pages.id = ${pageId}::uuid
        UNION ALL
        SELECT parent.parent_page_id, ancestors.depth + 1
        FROM ancestors
        JOIN pages AS parent ON parent.id = ancestors.ancestor_id
      )
      SELECT pages.id, pages.slug_id AS "slugId", pages.title
      FROM ancestors
      JOIN page_access ON page_access.page_id = ancestors.ancestor_id
      JOIN pages ON pages.id = ancestors.ancestor_id
      ORDER BY ancestors.depth ASC
      LIMIT 1
    `.execute(this.db);
    return rows[0];
  }

  private async workspaceUserIds(ids: string[], workspaceId: string) {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', ids)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  private async workspaceGroupIds(ids: string[], workspaceId: string) {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('groups')
      .select('id')
      .where('id', 'in', ids)
      .where('workspaceId', '=', workspaceId)
      .execute();
    return rows.map((row) => row.id);
  }
}

function unique(ids?: string[]): string[] {
  return [...new Set(ids ?? [])];
}
