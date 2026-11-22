import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { BaseViewRepo } from '@docmost/db/repos/base/base-view.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BaseRowService } from '../services/base-row.service';
import { BaseVisibilityService } from '../services/base-visibility.service';
import { buildIcs, IcsEvent, wholeDay } from './base-ics';

const DATE_LIKE = ['date', 'createdAt', 'lastEditedAt'];
// what a feed carries at most, and how far back it looks
const MAX_EVENTS = 5000;
const PAGE_SIZE = 100;
const PAST_DAYS = 400;
const DESCRIPTION_LINES = 8;

type Property = {
  id: string;
  name: string;
  type: string;
  isPrimary?: boolean;
  typeOptions?: any;
};

// The private link of one person for one view. The address is a secret, and
// what it shows is what that person may see today.
@Injectable()
export class BaseCalendarFeedService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly baseRepo: BaseRepo,
    private readonly viewRepo: BaseViewRepo,
    private readonly propertyRepo: BasePropertyRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly userRepo: UserRepo,
    private readonly pageAccess: PageAccessService,
    private readonly rows: BaseRowService,
    private readonly visibility: BaseVisibilityService,
  ) {}

  async info(user: User, workspaceId: string, pageId: string, viewId: string) {
    await this.viewOf(user, workspaceId, pageId, viewId);
    const feed = await this.db
      .selectFrom('baseCalendarFeeds')
      .select(['token', 'createdAt', 'lastReadAt'])
      .where('viewId', '=', viewId)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    return {
      enabled: Boolean(feed),
      path: feed ? pathOf(feed.token) : null,
      createdAt: feed?.createdAt ?? null,
      lastReadAt: feed?.lastReadAt ?? null,
    };
  }

  // Makes the link, or a new one in place of the one there was: the old
  // address stops answering.
  async create(user: User, workspaceId: string, pageId: string, viewId: string) {
    await this.viewOf(user, workspaceId, pageId, viewId);
    const token = randomBytes(24).toString('base64url');
    const values = { workspaceId, pageId, viewId, userId: user.id, token };
    await this.db
      .insertInto('baseCalendarFeeds')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['viewId', 'userId']).doUpdateSet({ token, createdAt: new Date(), lastReadAt: null }),
      )
      .execute();
    return { enabled: true, path: pathOf(token), createdAt: new Date(), lastReadAt: null };
  }

  async remove(user: User, workspaceId: string, pageId: string, viewId: string) {
    await this.db
      .deleteFrom('baseCalendarFeeds')
      .where('viewId', '=', viewId)
      .where('userId', '=', user.id)
      .where('workspaceId', '=', workspaceId)
      .where('pageId', '=', pageId)
      .execute();
    return { enabled: false, path: null, createdAt: null, lastReadAt: null };
  }

  // The feed behind a link, or null when the link is not known any more or
  // its owner may no longer read the base.
  async render(token: string, workspaceId: string, origin: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
    const feed = await this.db
      .selectFrom('baseCalendarFeeds')
      .selectAll()
      .where('token', '=', token)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!feed) return null;
    const user = await this.userRepo.findById(feed.userId, workspaceId);
    if (!user || user.deletedAt || user.deactivatedAt) return null;
    const base = await this.baseRepo.findById(feed.pageId);
    if (!base || base.workspaceId !== workspaceId) return null;
    const view = await this.viewRepo.findById(feed.viewId, { workspaceId });
    if (!view || view.pageId !== base.id) return null;
    try {
      await this.pageAccess.validateCanView(base, user);
    } catch {
      return null;
    }

    const hidden = await this.visibility.hiddenFor(user, base);
    const properties = ((await this.propertyRepo.findByPageId(base.id)) as unknown as Property[]).filter(
      (p) => !hidden.has(p.id),
    );
    const config = (view.config ?? {}) as Record<string, any>;
    const by = dateProperty(properties, config.calendarPropertyId ?? config.timelineStartPropertyId);
    const space = await this.spaceRepo.findById(base.spaceId, workspaceId);
    const url = space ? `${origin}/s/${space.slug}/p/${base.slugId}` : undefined;
    const name = [base.title || 'Untitled', view.name].filter(Boolean).join(' · ');
    const host = hostOf(origin);

    const events: IcsEvent[] = [];
    if (by) {
      const primary = properties.find((p) => p.isPrimary);
      const shown = descriptionProperties(properties, config, by, primary);
      const children: unknown[] = [];
      if (config.filter?.children?.length) children.push(config.filter);
      if (by.type === 'date') {
        const since = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
        children.push({ propertyId: by.id, op: 'onOrAfter', value: since });
      }
      let cursor: string | undefined;
      while (events.length < MAX_EVENTS) {
        const pagination = Object.assign(new PaginationOptions(), { limit: PAGE_SIZE, cursor });
        const page: any = await this.rows.list(
          { pageId: base.id, filter: children.length ? { op: 'and', children } : undefined } as any,
          pagination,
          workspaceId,
          { hidden },
        );
        for (const row of page.items ?? []) {
          const event = toEvent(row, by, primary, shown, user.timezone, url);
          if (event) events.push(event);
          if (events.length >= MAX_EVENTS) break;
        }
        cursor = page.meta?.nextCursor ?? undefined;
        if (!page.meta?.hasNextPage || !cursor) break;
      }
    }

    await this.db
      .updateTable('baseCalendarFeeds')
      .set({ lastReadAt: new Date() })
      .where('id', '=', feed.id)
      .execute();
    return buildIcs({ name, host, events });
  }

  private async viewOf(user: User, workspaceId: string, pageId: string, viewId: string) {
    const base = await this.baseRepo.findById(pageId);
    if (!base || base.workspaceId !== workspaceId) throw new NotFoundException('Base not found');
    await this.pageAccess.validateCanView(base, user);
    const view = await this.viewRepo.findById(viewId, { workspaceId });
    if (!view || view.pageId !== base.id) throw new NotFoundException('View not found');
    // a guest of one page keeps to the app: links that outlive a session are for members
    if (!user || user.deactivatedAt) throw new ForbiddenException();
    return { base, view };
  }
}

function pathOf(token: string): string {
  return `/api/bases/calendar-feed/${token}.ics`;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname || 'docmore';
  } catch {
    return 'docmore';
  }
}

// The date the rows are placed by: the one the view names, else the first
// date of the base.
export function dateProperty(properties: Property[], configuredId: string | undefined): Property | undefined {
  const configured = configuredId ? properties.find((p) => p.id === configuredId && DATE_LIKE.includes(p.type)) : undefined;
  return configured ?? properties.find((p) => DATE_LIKE.includes(p.type));
}

const DESCRIBABLE = ['text', 'longText', 'number', 'select', 'status', 'multiSelect', 'checkbox', 'url', 'email', 'phone'];

function descriptionProperties(properties: Property[], config: Record<string, any>, by: Property, primary?: Property): Property[] {
  const hiddenInView = new Set<string>(Array.isArray(config.hiddenPropertyIds) ? config.hiddenPropertyIds : []);
  const visible: string[] | undefined = Array.isArray(config.visiblePropertyIds) ? config.visiblePropertyIds : undefined;
  return properties
    .filter((p) => p.id !== by.id && p.id !== primary?.id && DESCRIBABLE.includes(p.type))
    .filter((p) => !hiddenInView.has(p.id) && (!visible || visible.includes(p.id)))
    .slice(0, DESCRIPTION_LINES);
}

function choiceName(property: Property, id: unknown): string | undefined {
  const choices = property.typeOptions?.choices;
  if (!Array.isArray(choices)) return undefined;
  const match = choices.find((c: any) => c?.id === String(id));
  return typeof match?.name === 'string' ? match.name : undefined;
}

export function cellText(property: Property, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  switch (property.type) {
    case 'select':
    case 'status':
      return choiceName(property, value) ?? '';
    case 'multiSelect':
      return Array.isArray(value)
        ? value.map((id) => choiceName(property, id)).filter(Boolean).join(', ')
        : '';
    case 'checkbox':
      return value === true ? 'Yes' : '';
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    default:
      // rich text and other shapes are left out: only plain strings are shown
      return typeof value === 'string' ? value.trim().slice(0, 500) : '';
  }
}

export function toEvent(
  row: { id: string; cells?: unknown; createdAt?: unknown; updatedAt?: unknown },
  by: Property,
  primary: Property | undefined,
  shown: Property[],
  timeZone: string | null | undefined,
  url?: string,
): IcsEvent | null {
  const cells = (row.cells ?? {}) as Record<string, unknown>;
  const raw = by.type === 'createdAt' ? row.createdAt : by.type === 'lastEditedAt' ? row.updatedAt : cells[by.id];
  const start = raw instanceof Date ? raw : typeof raw === 'string' && raw ? new Date(raw) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const title = primary ? cells[primary.id] : undefined;
  const timed = by.type === 'date' && by.typeOptions?.includeTime === true;
  const lines = shown
    .map((p) => {
      const text = cellText(p, cells[p.id]);
      return text ? `${p.name}: ${text}` : '';
    })
    .filter(Boolean);
  const updated = row.updatedAt instanceof Date ? row.updatedAt : typeof row.updatedAt === 'string' ? new Date(row.updatedAt) : undefined;
  return {
    uid: row.id,
    title: typeof title === 'string' && title.trim() ? title.trim() : 'Untitled',
    start,
    allDay: !timed,
    day: timed ? undefined : by.type === 'date' ? wholeDay(start, timeZone) : wholeDay(new Date(start.getTime() + 1), timeZone),
    updatedAt: updated && !Number.isNaN(updated.getTime()) ? updated : undefined,
    url,
    description: lines.length ? lines.join('\n') : undefined,
  };
}
