import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page-access/page-access.service';
import { PageService } from '../services/page.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { AUDIT_SERVICE, IAuditService } from '../../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import { jsonToNode } from '../../../collaboration/collaboration.util';

export interface SuggestionView {
  id: string;
  pageId: string;
  spaceId: string;
  authorId: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  title: string | null;
  note: string | null;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  content?: unknown;
  baseContent?: unknown;
}

const MAX_OPEN_PER_PAGE = 50;

// Suggest mode: anyone who can read a page proposes a new version of it;
// whoever can edit the page accepts (the page takes that version) or
// rejects it. The author can withdraw an open one.
@Injectable()
export class PageSuggestionService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
    private readonly pageService: PageService,
    private readonly notifications: NotificationService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  async list(user: User, workspaceId: string, pageId: string, status?: string): Promise<SuggestionView[]> {
    const page = await this.readablePage(user, workspaceId, pageId);
    let q = this.db
      .selectFrom('pageSuggestions')
      .leftJoin('users', 'users.id', 'pageSuggestions.authorId')
      .select(['pageSuggestions.id', 'pageSuggestions.pageId', 'pageSuggestions.spaceId', 'pageSuggestions.authorId', 'pageSuggestions.title', 'pageSuggestions.note', 'pageSuggestions.status', 'pageSuggestions.reviewerId', 'pageSuggestions.reviewNote', 'pageSuggestions.reviewedAt', 'pageSuggestions.createdAt', 'users.name as authorName', 'users.avatarUrl as authorAvatar'])
      .where('pageSuggestions.pageId', '=', page.id);
    if (status) q = q.where('pageSuggestions.status', '=', status);
    const rows = await q.orderBy('pageSuggestions.createdAt', 'desc').limit(100).execute();
    return rows.map((r: any) => view(r));
  }

  async count(user: User, workspaceId: string, pageId: string): Promise<{ open: number }> {
    const page = await this.readablePage(user, workspaceId, pageId);
    const row = await this.db
      .selectFrom('pageSuggestions')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('pageId', '=', page.id)
      .where('status', '=', 'open')
      .executeTakeFirst();
    return { open: Number(row?.n ?? 0) };
  }

  async info(user: User, workspaceId: string, suggestionId: string): Promise<SuggestionView & { pageContent: unknown; canReview: boolean }> {
    const row = await this.row(workspaceId, suggestionId);
    const page = await this.readablePage(user, workspaceId, row.pageId, true);
    let canReview = true;
    try {
      await this.pageAccess.validateCanEdit(page, user);
    } catch {
      canReview = false;
    }
    const author = await this.db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', '=', row.authorId).executeTakeFirst();
    return { ...view({ ...row, authorName: author?.name, authorAvatar: author?.avatarUrl }), content: row.content, baseContent: row.baseContent, pageContent: page.content ?? null, canReview };
  }

  async create(user: User, workspaceId: string, input: { pageId: string; content: unknown; title?: string; note?: string }): Promise<SuggestionView> {
    const page = await this.readablePage(user, workspaceId, input.pageId, true);
    if (page.isBase) throw new BadRequestException('Bases take no suggestions');
    try {
      jsonToNode(input.content as any);
    } catch {
      throw new BadRequestException('Invalid content');
    }
    const open = await this.count(user, workspaceId, page.id);
    if (open.open >= MAX_OPEN_PER_PAGE) throw new BadRequestException('Too many open suggestions on this page');
    const row = await this.db
      .insertInto('pageSuggestions')
      .values({
        workspaceId,
        spaceId: page.spaceId,
        pageId: page.id,
        authorId: user.id,
        title: input.title?.trim().slice(0, 500) || null,
        note: input.note?.trim().slice(0, 4000) || null,
        baseContent: (page.content ?? null) as any,
        content: input.content as any,
        status: 'open',
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.log({ event: AuditEvent.PAGE_SUGGESTION_CREATED, resourceType: AuditResource.PAGE, resourceId: page.id, spaceId: page.spaceId, changes: { after: { suggestionId: row.id, title: row.title } } });
    // the owner and the last editor hear about it; never the author
    const recipients = new Set<string>([page.ownerId, page.lastUpdatedById, page.creatorId].filter((id): id is string => Boolean(id) && id !== user.id));
    for (const userId of recipients) {
      await this.notifications
        .create({ userId, workspaceId, type: NotificationType.PAGE_SUGGESTION_CREATED, actorId: user.id, pageId: page.id, spaceId: page.spaceId, data: { suggestionId: row.id, note: row.note } } as any)
        .catch(() => undefined);
    }
    return view({ ...row, authorName: user.name, authorAvatar: (user as any).avatarUrl });
  }

  // The page takes the proposed version.
  async accept(user: User, workspaceId: string, suggestionId: string, reviewNote?: string): Promise<SuggestionView> {
    const row = await this.row(workspaceId, suggestionId);
    if (row.status !== 'open') throw new BadRequestException(`This suggestion was already ${row.status}`);
    const page = await this.pageRepo.findById(row.pageId, { includeContent: true });
    if (!page || page.deletedAt) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanEdit(page, user);
    await this.pageService.update(page, { pageId: page.id, content: row.content, format: 'json', operation: 'replace', ...(row.title ? { title: row.title } : {}) } as any, user);
    const updated = await this.resolve(row.id, 'accepted', user.id, reviewNote);
    this.audit.log({ event: AuditEvent.PAGE_SUGGESTION_ACCEPTED, resourceType: AuditResource.PAGE, resourceId: page.id, spaceId: page.spaceId, changes: { after: { suggestionId: row.id } } });
    if (row.authorId !== user.id) {
      await this.notifications
        .create({ userId: row.authorId, workspaceId, type: NotificationType.PAGE_SUGGESTION_ACCEPTED, actorId: user.id, pageId: page.id, spaceId: page.spaceId, data: { suggestionId: row.id, reviewNote: reviewNote ?? null } } as any)
        .catch(() => undefined);
    }
    return view(updated);
  }

  async reject(user: User, workspaceId: string, suggestionId: string, reviewNote?: string): Promise<SuggestionView> {
    const row = await this.row(workspaceId, suggestionId);
    if (row.status !== 'open') throw new BadRequestException(`This suggestion was already ${row.status}`);
    const page = await this.pageRepo.findById(row.pageId);
    if (!page || page.deletedAt) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanEdit(page, user);
    const updated = await this.resolve(row.id, 'rejected', user.id, reviewNote);
    this.audit.log({ event: AuditEvent.PAGE_SUGGESTION_REJECTED, resourceType: AuditResource.PAGE, resourceId: page.id, spaceId: page.spaceId, changes: { after: { suggestionId: row.id, reviewNote: reviewNote ?? null } } });
    if (row.authorId !== user.id) {
      await this.notifications
        .create({ userId: row.authorId, workspaceId, type: NotificationType.PAGE_SUGGESTION_REJECTED, actorId: user.id, pageId: page.id, spaceId: page.spaceId, data: { suggestionId: row.id, reviewNote: reviewNote ?? null } } as any)
        .catch(() => undefined);
    }
    return view(updated);
  }

  async withdraw(user: User, workspaceId: string, suggestionId: string): Promise<SuggestionView> {
    const row = await this.row(workspaceId, suggestionId);
    if (row.authorId !== user.id) throw new ForbiddenException('Only the author withdraws a suggestion');
    if (row.status !== 'open') throw new BadRequestException(`This suggestion was already ${row.status}`);
    return view(await this.resolve(row.id, 'withdrawn', user.id));
  }

  private async resolve(id: string, status: string, reviewerId: string, reviewNote?: string) {
    return this.db
      .updateTable('pageSuggestions')
      .set({ status, reviewerId, reviewNote: reviewNote?.trim().slice(0, 4000) || null, reviewedAt: new Date(), updatedAt: new Date() } as any)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async row(workspaceId: string, suggestionId: string) {
    const row = await this.db.selectFrom('pageSuggestions').selectAll().where('id', '=', suggestionId).where('workspaceId', '=', workspaceId).executeTakeFirst();
    if (!row) throw new NotFoundException('Suggestion not found');
    return row;
  }

  private async readablePage(user: User, workspaceId: string, pageId: string, withContent = false): Promise<Page> {
    const page = await this.pageRepo.findById(pageId, withContent ? { includeContent: true } : undefined);
    if (!page || page.deletedAt || page.workspaceId !== workspaceId) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanView(page, user);
    return page;
  }
}

function view(r: any): SuggestionView {
  return {
    id: r.id,
    pageId: r.pageId,
    spaceId: r.spaceId,
    authorId: r.authorId,
    author: r.authorName ? { id: r.authorId, name: r.authorName, avatarUrl: r.authorAvatar ?? null } : null,
    title: r.title ?? null,
    note: r.note ?? null,
    status: r.status,
    reviewerId: r.reviewerId ?? null,
    reviewNote: r.reviewNote ?? null,
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}
