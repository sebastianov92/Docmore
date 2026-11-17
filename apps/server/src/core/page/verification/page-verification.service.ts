import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { Page, PageVerification, User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageAccessService } from '../page-access/page-access.service';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { WsService } from '../../../ws/ws.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { PageVerificationRepo } from './page-verification.repo';
import {
  RejectApprovalDto,
  SetupVerificationDto,
  UpdateVerificationDto,
  VerificationListDto,
} from './dto/page-verification.dto';
import {
  computeExpiresAt,
  deriveStatus,
  ExpirationMode,
  ExpirationSettings,
  hasPageChanged,
  isValidPeriod,
  MAX_VERIFIERS,
  PeriodUnit,
  uniqueIds,
  VerificationStatus,
} from './page-verification.utils';

interface Actor {
  user: User;
  workspace: Workspace;
}

// Two ways to keep a page trustworthy: recurring verification (verifiers
// re-confirm it before it expires) and an approval workflow (draft, in
// approval, approved, obsolete). Edits to a verified or approved page are
// detected elsewhere and send it back; this service covers everything
// people do on purpose.
@Injectable()
export class PageVerificationService {
  private readonly logger = new Logger(PageVerificationService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: PageVerificationRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryRepo: PageHistoryRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly collaborationGateway: CollaborationGateway,
    private readonly wsService: WsService,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  // ---- reads -------------------------------------------------------------

  async getInfo(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanView(page, actor.user);
    const row = await this.repo.findByPageId(page.id);
    if (!row) {
      return { status: 'none' as VerificationStatus, pageId: page.id };
    }
    return this.toInfo(row, page, actor);
  }

  async getChanges(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanView(page, actor.user);
    const row = await this.repo.findByPageId(page.id);
    if (!row) {
      throw new NotFoundException('This page has no verification');
    }

    await this.flushCollaboration(page.id);
    const current = await this.pageRepo.findById(page.id, {
      includeContent: true,
      includeLastUpdatedBy: true,
    });

    const baseline = async (historyId: string | null) => {
      if (!historyId) return null;
      const history = await this.pageHistoryRepo.findById(historyId, { includeContent: true });
      if (!history) return null;
      return {
        historyId,
        title: history.title,
        content: history.content,
        hasChanges: hasPageChanged(
          { title: history.title, content: history.content },
          { title: current.title, content: current.content },
        ),
      };
    };

    const [verified, rejected, users] = await Promise.all([
      baseline(row.verifiedHistoryId),
      baseline(row.rejectedHistoryId),
      this.userRefs([row.verifiedById, row.rejectedById]),
    ]);

    return {
      type: row.type,
      verified: verified
        ? { ...verified, verifiedAt: row.verifiedAt, verifiedBy: users.get(row.verifiedById) ?? null }
        : null,
      rejected: rejected
        ? { ...rejected, rejectedAt: row.rejectedAt, rejectedBy: users.get(row.rejectedById) ?? null }
        : null,
      current: {
        title: current.title,
        content: current.content,
        updatedAt: current.updatedAt,
        lastUpdatedBy: (current as any).lastUpdatedBy ?? null,
      },
    };
  }

  async list(dto: VerificationListDto, actor: Actor) {
    const limit = Math.min(Math.max(dto.limit ?? 50, 1), 100);
    const query = this.db
      .selectFrom('pageVerifications')
      .innerJoin('pages', 'pages.id', 'pageVerifications.pageId')
      .innerJoin('spaces', 'spaces.id', 'pageVerifications.spaceId')
      .select((eb) => [
        'pageVerifications.id',
        'pageVerifications.pageId',
        'pageVerifications.spaceId',
        'pageVerifications.type',
        'pageVerifications.status',
        'pageVerifications.mode',
        'pageVerifications.periodAmount',
        'pageVerifications.periodUnit',
        'pageVerifications.verifiedAt',
        'pageVerifications.expiresAt',
        'pageVerifications.invalidatedAt',
        'pageVerifications.createdAt',
        'pages.title as pageTitle',
        'pages.slugId as pageSlugId',
        'pages.icon as pageIcon',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
        this.repo.withUser(eb, 'verifiedById', 'verifiedBy'),
        this.repo.withVerifiers(eb),
      ])
      .where('pageVerifications.workspaceId', '=', actor.workspace.id)
      .where('pages.deletedAt', 'is', null)
      .where(
        'pageVerifications.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(actor.user.id),
      )
      .$if(Boolean(dto.spaceIds?.length), (qb) =>
        qb.where('pageVerifications.spaceId', 'in', dto.spaceIds),
      )
      .$if(Boolean(dto.type), (qb) => qb.where('pageVerifications.type', '=', dto.type))
      .$if(Boolean(dto.verifierId), (qb) =>
        qb.where(
          'pageVerifications.id',
          'in',
          this.db
            .selectFrom('pageVerifiers')
            .select('pageVerificationId')
            .where('userId', '=', dto.verifierId),
        ),
      )
      .$if(Boolean(dto.query?.trim()), (qb) =>
        qb.where(
          sql`lower(pages.title)`,
          'like',
          sql`lower(${'%' + dto.query.trim().replace(/[\\%_]/g, '\\$&') + '%'})`,
        ),
      );

    const result = await executeWithCursorPagination(query, {
      perPage: limit,
      cursor: dto.cursor,
      beforeCursor: dto.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });

    const rows = result.items as any[];
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: rows.map((r) => r.pageId),
        userId: actor.user.id,
      }),
    );
    const now = new Date();
    const items = rows
      .filter((r) => accessible.has(r.pageId))
      .map((r) => ({ ...r, status: deriveStatus(r, now) }));
    return { items, meta: result.meta };
  }

  // ---- lifecycle ---------------------------------------------------------

  async setup(dto: SetupVerificationDto, actor: Actor) {
    const page = await this.loadPage(dto.pageId, actor);
    await this.pageAccessService.validateCanEdit(page, actor.user);
    if (await this.repo.findByPageId(page.id)) {
      throw new BadRequestException('This page already has a verification');
    }

    const verifierIds = uniqueIds(dto.verifierIds);
    await this.assertVerifiers(verifierIds, page);
    const now = new Date();
    const settings = dto.type === 'expiring' ? this.readExpiration(dto, now) : null;

    const row = await executeTx(this.db, async (trx) => {
      let verifiedHistoryId: string | null = null;
      if (dto.type === 'expiring') {
        verifiedHistoryId = await this.recordBaseline(page.id, trx);
      }
      const created = await this.repo.insert(
        {
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          type: dto.type,
          creatorId: actor.user.id,
          ...(dto.type === 'expiring'
            ? {
                status: 'verified',
                mode: settings.mode,
                periodAmount: settings.periodAmount,
                periodUnit: settings.periodUnit,
                verifiedAt: now,
                verifiedById: actor.user.id,
                expiresAt: computeExpiresAt(settings, now),
                verifiedHistoryId,
              }
            : { status: 'draft' }),
        },
        trx,
      );
      await this.repo.syncVerifiers(created.id, verifierIds, actor.user.id, trx);
      return created;
    });

    this.auditService.log({
      event: AuditEvent.PAGE_VERIFICATION_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title, verificationType: dto.type, verifierIds },
    });
    if (dto.type === 'expiring') {
      this.auditService.log({
        event: AuditEvent.PAGE_VERIFIED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        metadata: { pageTitle: page.title, verificationType: dto.type },
      });
      await this.queueVerified(page, actor, verifierIds);
    }
    await this.broadcast(page);
    return this.toInfo(row, page, actor);
  }

  async update(dto: UpdateVerificationDto, actor: Actor) {
    const page = await this.loadPage(dto.pageId, actor);
    await this.pageAccessService.validateCanEdit(page, actor.user);
    const row = await this.requireRow(page.id);

    const verifierIds = dto.verifierIds ? uniqueIds(dto.verifierIds) : null;
    if (verifierIds) {
      await this.assertVerifiers(verifierIds, page);
    }

    const changes: Record<string, any> = {};
    const patch: Record<string, any> = {};
    if (row.type === 'expiring' && (dto.mode || dto.periodAmount || dto.periodUnit || dto.fixedExpiresAt)) {
      const settings = this.readExpiration(
        {
          mode: dto.mode ?? (row.mode as ExpirationMode) ?? 'period',
          periodAmount: dto.periodAmount ?? row.periodAmount ?? undefined,
          periodUnit: dto.periodUnit ?? (row.periodUnit as PeriodUnit) ?? undefined,
          fixedExpiresAt: dto.fixedExpiresAt,
        },
        new Date(),
      );
      patch.mode = settings.mode;
      patch.periodAmount = settings.periodAmount;
      patch.periodUnit = settings.periodUnit;
      // The clock keeps running from the last verification.
      patch.expiresAt = row.verifiedAt ? computeExpiresAt(settings, row.verifiedAt) : null;
      changes.expiration = { mode: settings.mode, periodAmount: settings.periodAmount, periodUnit: settings.periodUnit };
    }

    let verifierDiff = { added: [] as string[], removed: [] as string[] };
    const updated = await executeTx(this.db, async (trx) => {
      const next = Object.keys(patch).length > 0 ? await this.repo.update(row.id, patch, trx) : row;
      if (verifierIds) {
        verifierDiff = await this.repo.syncVerifiers(row.id, verifierIds, actor.user.id, trx);
      }
      return next;
    });

    this.auditService.log({
      event: AuditEvent.PAGE_VERIFICATION_UPDATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title, ...changes, ...verifierDiff },
    });
    for (const userId of verifierDiff.added) {
      this.auditService.log({
        event: AuditEvent.PAGE_VERIFIER_ADDED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        metadata: { pageTitle: page.title, userId },
      });
    }
    for (const userId of verifierDiff.removed) {
      this.auditService.log({
        event: AuditEvent.PAGE_VERIFIER_REMOVED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        metadata: { pageTitle: page.title, userId },
      });
    }
    await this.broadcast(page);
    return this.toInfo(updated, page, actor);
  }

  async remove(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanEdit(page, actor.user);
    const row = await this.requireRow(page.id);
    await this.repo.delete(row.id);
    this.auditService.log({
      event: AuditEvent.PAGE_VERIFICATION_REMOVED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title, verificationType: row.type },
    });
    await this.broadcast(page);
  }

  // Recurring: confirms the page as it is now and restarts the clock.
  // Approval: approves a page that is in approval.
  async verify(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanView(page, actor.user);
    const row = await this.requireRow(page.id);
    if (!(await this.canVerify(row, page, actor))) {
      throw new ForbiddenException('Only a verifier of this page can do that');
    }
    if (row.type === 'qms' && row.status !== 'in_approval') {
      throw new BadRequestException('The page is not waiting for approval');
    }

    await this.flushCollaboration(page.id);
    const now = new Date();
    const updated = await executeTx(this.db, async (trx) => {
      const verifiedHistoryId = await this.recordBaseline(page.id, trx);
      return this.repo.update(
        row.id,
        {
          verifiedAt: now,
          verifiedById: actor.user.id,
          verifiedHistoryId,
          invalidatedAt: null,
          invalidatedById: null,
          ...(row.type === 'expiring'
            ? {
                status: 'verified',
                expiresAt: computeExpiresAt(this.settingsOf(row), now),
              }
            : {
                status: 'approved',
                rejectedAt: null,
                rejectedById: null,
                rejectionComment: null,
                rejectedHistoryId: null,
              }),
        },
        trx,
      );
    });

    this.auditService.log({
      event: AuditEvent.PAGE_VERIFIED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title, verificationType: row.type },
    });
    const verifiers = await this.repo.findVerifiers(row.id);
    await this.queueVerified(page, actor, verifiers.map((v) => v.id));
    await this.broadcast(page);
    return this.toInfo(updated, page, actor);
  }

  async submitForApproval(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanEdit(page, actor.user);
    const row = await this.requireRow(page.id);
    if (row.type !== 'qms') {
      throw new BadRequestException('This page does not use the approval workflow');
    }
    if (row.status !== 'draft' && row.status !== 'approved') {
      throw new BadRequestException('The page is already waiting for approval');
    }

    const now = new Date();
    const updated = await this.repo.update(row.id, {
      status: 'in_approval',
      requestedAt: now,
      requestedById: actor.user.id,
      invalidatedAt: null,
      invalidatedById: null,
    });

    this.auditService.log({
      event: AuditEvent.PAGE_APPROVAL_REQUESTED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title },
    });
    const verifiers = await this.repo.findVerifiers(row.id);
    await this.safeQueue(QueueJob.PAGE_APPROVAL_REQUESTED_NOTIFICATION, {
      pageId: page.id,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      actorId: actor.user.id,
      verifierIds: verifiers.map((v) => v.id),
    });
    await this.broadcast(page);
    return this.toInfo(updated, page, actor);
  }

  async reject(dto: RejectApprovalDto, actor: Actor) {
    const page = await this.loadPage(dto.pageId, actor);
    await this.pageAccessService.validateCanView(page, actor.user);
    const row = await this.requireRow(page.id);
    if (row.type !== 'qms' || row.status !== 'in_approval') {
      throw new BadRequestException('The page is not waiting for approval');
    }
    if (!(await this.canVerify(row, page, actor))) {
      throw new ForbiddenException('Only a verifier of this page can do that');
    }

    await this.flushCollaboration(page.id);
    const now = new Date();
    const comment = dto.comment?.trim() || null;
    const updated = await executeTx(this.db, async (trx) => {
      const rejectedHistoryId = await this.recordBaseline(page.id, trx);
      return this.repo.update(
        row.id,
        {
          status: 'draft',
          rejectedAt: now,
          rejectedById: actor.user.id,
          rejectionComment: comment,
          rejectedHistoryId,
        },
        trx,
      );
    });

    this.auditService.log({
      event: AuditEvent.PAGE_APPROVAL_REJECTED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title, comment },
    });
    if (row.requestedById) {
      await this.safeQueue(QueueJob.PAGE_APPROVAL_REJECTED_NOTIFICATION, {
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        actorId: actor.user.id,
        requestedById: row.requestedById,
        comment: comment ?? undefined,
      });
    }
    await this.broadcast(page);
    return this.toInfo(updated, page, actor);
  }

  async markObsolete(pageId: string, actor: Actor) {
    const page = await this.loadPage(pageId, actor);
    await this.pageAccessService.validateCanView(page, actor.user);
    const row = await this.requireRow(page.id);
    if (row.type !== 'qms' || row.status !== 'approved') {
      throw new BadRequestException('Only an approved page can be marked obsolete');
    }
    if (!(await this.canVerify(row, page, actor))) {
      throw new ForbiddenException('Only a verifier of this page can do that');
    }
    const updated = await this.repo.update(row.id, { status: 'obsolete' });
    this.auditService.log({
      event: AuditEvent.PAGE_MARKED_OBSOLETE,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: { pageTitle: page.title },
    });
    await this.broadcast(page);
    return this.toInfo(updated, page, actor);
  }

  // ---- helpers -----------------------------------------------------------

  private async loadPage(pageId: string, actor: Actor): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== actor.workspace.id || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }
    return page;
  }

  private async requireRow(pageId: string): Promise<PageVerification> {
    const row = await this.repo.findByPageId(pageId);
    if (!row) {
      throw new NotFoundException('This page has no verification');
    }
    return row;
  }

  private settingsOf(row: PageVerification): ExpirationSettings {
    return {
      mode: (row.mode as ExpirationMode) ?? 'indefinite',
      periodAmount: row.periodAmount,
      periodUnit: row.periodUnit as PeriodUnit | null,
      // A fixed date that already passed was recorded in expiresAt.
      fixedExpiresAt: row.mode === 'fixed' ? row.expiresAt : null,
    };
  }

  private readExpiration(
    input: { mode?: string; periodAmount?: number; periodUnit?: string; fixedExpiresAt?: string },
    now: Date,
  ): ExpirationSettings {
    const mode = (input.mode ?? 'period') as ExpirationMode;
    if (mode === 'period') {
      if (!isValidPeriod(input.periodAmount, input.periodUnit)) {
        throw new BadRequestException('Choose a valid verification period');
      }
      return { mode, periodAmount: input.periodAmount, periodUnit: input.periodUnit as PeriodUnit, fixedExpiresAt: null };
    }
    if (mode === 'fixed') {
      const date = input.fixedExpiresAt ? new Date(input.fixedExpiresAt) : null;
      if (!date || Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
        throw new BadRequestException('The expiry date must be in the future');
      }
      return { mode, periodAmount: null, periodUnit: null, fixedExpiresAt: date };
    }
    return { mode: 'indefinite', periodAmount: null, periodUnit: null, fixedExpiresAt: null };
  }

  // Verifiers must be active members who can open the page.
  private async assertVerifiers(userIds: string[], page: Page) {
    if (userIds.length === 0) {
      throw new BadRequestException('Add at least one verifier');
    }
    if (userIds.length > MAX_VERIFIERS) {
      throw new BadRequestException(`A page can have at most ${MAX_VERIFIERS} verifiers`);
    }
    const active = await this.db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', userIds)
      .where('workspaceId', '=', page.workspaceId)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .execute();
    if (active.length !== userIds.length) {
      throw new BadRequestException('One of the verifiers is not an active member');
    }
    const inSpace = await this.spaceMemberRepo.getUserIdsWithSpaceAccess(userIds, page.spaceId);
    const withAccess = new Set(
      inSpace.size > 0
        ? await this.pagePermissionRepo.getUserIdsWithPageAccess(page.id, [...inSpace])
        : [],
    );
    if (userIds.some((id) => !withAccess.has(id))) {
      throw new BadRequestException('Every verifier needs access to this page');
    }
  }

  private async canVerify(row: PageVerification, page: Page, actor: Actor): Promise<boolean> {
    const verifiers = await this.repo.findVerifiers(row.id);
    if (verifiers.some((v) => v.id === actor.user.id)) return true;
    const ability = await this.spaceAbility.createForUser(actor.user, page.spaceId);
    return ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings);
  }

  private async canEdit(page: Page, actor: Actor): Promise<boolean> {
    try {
      await this.pageAccessService.validateCanEdit(page, actor.user);
      return true;
    } catch {
      return false;
    }
  }

  private async toInfo(row: PageVerification, page: Page, actor: Actor) {
    const [verifiers, users, canEdit] = await Promise.all([
      this.repo.findVerifiers(row.id),
      this.userRefs([row.verifiedById, row.requestedById, row.rejectedById, row.invalidatedById]),
      this.canEdit(page, actor),
    ]);
    const isVerifier = verifiers.some((v) => v.id === actor.user.id);
    let isAdmin = false;
    if (!isVerifier) {
      const ability = await this.spaceAbility.createForUser(actor.user, page.spaceId);
      isAdmin = ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings);
    }
    const status = deriveStatus(row, new Date());
    const canVerify = isVerifier || isAdmin;

    return {
      id: row.id,
      pageId: row.pageId,
      type: row.type,
      mode: row.mode,
      periodAmount: row.periodAmount,
      periodUnit: row.periodUnit,
      status,
      verifiedAt: row.verifiedAt,
      verifiedBy: users.get(row.verifiedById) ?? null,
      expiresAt: row.expiresAt,
      requestedAt: row.requestedAt,
      requestedBy: users.get(row.requestedById) ?? null,
      rejectedAt: row.rejectedAt,
      rejectedBy: users.get(row.rejectedById) ?? null,
      rejectionComment: row.rejectionComment,
      invalidatedAt: row.invalidatedAt,
      invalidatedBy: users.get(row.invalidatedById) ?? null,
      verifiedHistoryId: row.verifiedHistoryId,
      rejectedHistoryId: row.rejectedHistoryId,
      verifiers: verifiers.map(({ id, name, email, avatarUrl }) => ({ id, name, email, avatarUrl })),
      permissions: {
        canVerify,
        canManage: canEdit,
        canSubmitForApproval:
          canEdit && row.type === 'qms' && (status === 'draft' || status === 'approved'),
        canMarkObsolete: canVerify && row.type === 'qms' && status === 'approved',
      },
    };
  }

  private async userRefs(ids: Array<string | null | undefined>) {
    const wanted = uniqueIds(ids as string[]);
    const map = new Map<string, { id: string; name: string; avatarUrl: string | null }>();
    if (wanted.length === 0) return map;
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'avatarUrl'])
      .where('id', 'in', wanted)
      .execute();
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  // Snapshot of the page as it is, so later edits can be reviewed against it.
  private async recordBaseline(pageId: string, trx: KyselyTransaction): Promise<string> {
    const page = await this.pageRepo.findById(pageId, { includeContent: true, trx });
    const history = await this.pageHistoryRepo.saveHistory(page, { contributorIds: [], trx });
    return history.id;
  }

  // Pending collaborative edits live in memory until flushed; a baseline
  // or a diff must see them.
  private async flushCollaboration(pageId: string) {
    try {
      await this.collaborationGateway.handleYjsEvent('flushDocument', `page.${pageId}`, {});
    } catch (err: any) {
      this.logger.debug(`flush before verification skipped for ${pageId}: ${err?.message}`);
    }
  }

  private async queueVerified(page: Page, actor: Actor, verifierIds: string[]) {
    await this.safeQueue(QueueJob.PAGE_VERIFIED_NOTIFICATION, {
      pageId: page.id,
      spaceId: page.spaceId,
      workspaceId: page.workspaceId,
      actorId: actor.user.id,
      verifierIds,
    });
  }

  private async safeQueue(name: string, data: Record<string, unknown>) {
    try {
      await this.notificationQueue.add(name, data, { removeOnComplete: true });
    } catch (err: any) {
      this.logger.warn(`Could not queue ${name}: ${err?.message}`);
    }
  }

  private async broadcast(page: Page) {
    try {
      await this.wsService.emitCommentEvent(page.spaceId, page.id, {
        operation: 'verificationUpdated',
        pageId: page.id,
      });
    } catch (err: any) {
      this.logger.debug(`verificationUpdated not emitted for ${page.id}: ${err?.message}`);
    }
  }
}
