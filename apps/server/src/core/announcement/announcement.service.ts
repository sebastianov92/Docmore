import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Announcement, User } from '@docmost/db/types/entity.types';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AnnouncementAudience, AnnouncementColor, AnnouncementType } from './announcement.constants';
import { normalizeAnnouncementContent } from './announcement.content';
import { CreateAnnouncementDto, ListAnnouncementsDto, UpdateAnnouncementDto } from './dto/announcement.dto';

export type AnnouncementStatus = 'scheduled' | 'active' | 'ended' | 'archived';

export interface AnnouncementView {
  id: string;
  title: string;
  type: AnnouncementType;
  color: AnnouncementColor;
  content: unknown;
  isDismissible: boolean;
  audience: AnnouncementAudience;
  startsAt: string;
  endsAt: string | null;
  archivedAt: string | null;
  status: AnnouncementStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BannerView {
  id: string;
  type: AnnouncementType;
  color: AnnouncementColor;
  content: unknown;
  isDismissible: boolean;
  startsAt: string;
  endsAt: string | null;
}

interface Schedule {
  startsAt: Date;
  endsAt: Date | null;
}

type Takeover = { id: string; title: string; at: string };

// Banners shown at the top of the app (members) or of public pages
// (everyone). One shows at a time: a new one that overlaps another is
// refused with the overlap listed, or, with replace, cuts the others short.
@Injectable()
export class AnnouncementService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  // ---- reading ------------------------------------------------------------

  async list(workspaceId: string, dto: ListAnnouncementsDto) {
    let query = this.db.selectFrom('announcements').selectAll().where('workspaceId', '=', workspaceId);
    const status = dto.status ?? 'active';
    // "Current" is what still can show: not archived and not over.
    if (status === 'active') {
      query = query
        .where('archivedAt', 'is', null)
        .where((eb) => eb.or([eb('endsAt', 'is', null), eb('endsAt', '>', new Date())]));
    }
    if (status === 'archived') query = query.where('archivedAt', 'is not', null);
    const text = dto.query?.trim();
    if (text) {
      query = query.where((eb) =>
        eb.or([
          eb('title', 'ilike', `%${text}%`),
          eb(sql<boolean>`announcements.tsv @@ plainto_tsquery('english', f_unaccent(${text}))`, '=', true),
        ]),
      );
    }
    const result = await executeWithCursorPagination(query, {
      perPage: dto.limit,
      cursor: dto.cursor,
      beforeCursor: dto.beforeCursor,
      fields: [
        { expression: 'startsAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({ startsAt: new Date(cursor.startsAt as string), id: cursor.id }),
    });
    const now = Date.now();
    return { ...result, items: result.items.map((row) => this.toView(row as Announcement, now)) };
  }

  // Current and upcoming banners; the client switches at startsAt itself.
  async visible(workspaceId: string, surface: 'app' | 'public'): Promise<{ now: string; items: BannerView[] }> {
    const now = new Date();
    let query = this.db
      .selectFrom('announcements')
      .select(['id', 'type', 'color', 'content', 'isDismissible', 'startsAt', 'endsAt'])
      .where('workspaceId', '=', workspaceId)
      .where('archivedAt', 'is', null)
      .where((eb) => eb.or([eb('endsAt', 'is', null), eb('endsAt', '>', now)]))
      .orderBy('startsAt', 'asc')
      .limit(20);
    if (surface === 'public') query = query.where('audience', '=', 'everyone');
    const rows = await query.execute();
    return {
      now: now.toISOString(),
      items: rows.map((row) => ({
        id: row.id,
        type: row.type as AnnouncementType,
        color: row.color as AnnouncementColor,
        content: asObject(row.content),
        isDismissible: row.isDismissible,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
      })),
    };
  }

  // ---- writing ------------------------------------------------------------

  async create(workspaceId: string, user: User, dto: CreateAnnouncementDto): Promise<AnnouncementView> {
    const { content, text } = normalizeAnnouncementContent(dto.content);
    const schedule = this.readSchedule(dto, null);
    const cut = await this.resolveOverlap(workspaceId, null, schedule, dto.replace === true);

    const row = await this.db
      .insertInto('announcements')
      .values({
        workspaceId,
        title: dto.title.trim(),
        type: dto.type,
        color: dto.color,
        content: content as any,
        textContent: text,
        isDismissible: dto.isDismissible === true,
        audience: dto.audience ?? 'members',
        startsAt: schedule.startsAt,
        endsAt: cut.endsAt,
        creatorId: user.id,
        lastUpdatedById: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.applyCuts(cut.cutOthers, schedule.startsAt, user);
    this.audit.log({
      event: AuditEvent.ANNOUNCEMENT_CREATED,
      resourceType: AuditResource.ANNOUNCEMENT,
      resourceId: row.id,
      changes: { after: { title: row.title, type: row.type, audience: row.audience, startsAt: row.startsAt, endsAt: row.endsAt } },
    });
    return this.toView(row, Date.now());
  }

  async update(workspaceId: string, user: User, dto: UpdateAnnouncementDto): Promise<AnnouncementView> {
    const existing = await this.find(workspaceId, dto.announcementId);
    const { content, text } = normalizeAnnouncementContent(dto.content);
    const schedule = this.readSchedule(dto, existing);
    const cut = existing.archivedAt
      ? { endsAt: schedule.endsAt, cutOthers: [] as Announcement[] }
      : await this.resolveOverlap(workspaceId, existing.id, schedule, dto.replace === true);

    const row = await this.db
      .updateTable('announcements')
      .set({
        title: dto.title.trim(),
        type: dto.type,
        color: dto.color,
        content: content as any,
        textContent: text,
        isDismissible: dto.isDismissible === true,
        audience: dto.audience ?? existing.audience,
        startsAt: schedule.startsAt,
        endsAt: cut.endsAt,
        lastUpdatedById: user.id,
        updatedAt: new Date(),
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.applyCuts(cut.cutOthers, schedule.startsAt, user);
    this.audit.log({
      event: AuditEvent.ANNOUNCEMENT_UPDATED,
      resourceType: AuditResource.ANNOUNCEMENT,
      resourceId: row.id,
      changes: {
        before: { title: existing.title, type: existing.type, audience: existing.audience, startsAt: existing.startsAt, endsAt: existing.endsAt },
        after: { title: row.title, type: row.type, audience: row.audience, startsAt: row.startsAt, endsAt: row.endsAt },
      },
    });
    return this.toView(row, Date.now());
  }

  async archive(workspaceId: string, user: User, id: string): Promise<AnnouncementView> {
    const existing = await this.find(workspaceId, id);
    if (existing.archivedAt) return this.toView(existing, Date.now());
    const row = await this.db
      .updateTable('announcements')
      .set({ archivedAt: new Date(), lastUpdatedById: user.id, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.log({
      event: AuditEvent.ANNOUNCEMENT_ARCHIVED,
      resourceType: AuditResource.ANNOUNCEMENT,
      resourceId: row.id,
      changes: { after: { title: row.title } },
    });
    return this.toView(row, Date.now());
  }

  // Back from the archive only if nothing else shows in its window.
  async unarchive(workspaceId: string, user: User, id: string): Promise<AnnouncementView> {
    const existing = await this.find(workspaceId, id);
    if (!existing.archivedAt) return this.toView(existing, Date.now());
    const schedule = { startsAt: new Date(existing.startsAt), endsAt: existing.endsAt ? new Date(existing.endsAt) : null };
    if (schedule.endsAt && schedule.endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('This announcement already ended; edit its end time first');
    }
    await this.resolveOverlap(workspaceId, existing.id, schedule, false);
    const row = await this.db
      .updateTable('announcements')
      .set({ archivedAt: null, lastUpdatedById: user.id, updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.log({
      event: AuditEvent.ANNOUNCEMENT_UNARCHIVED,
      resourceType: AuditResource.ANNOUNCEMENT,
      resourceId: row.id,
      changes: { after: { title: row.title } },
    });
    return this.toView(row, Date.now());
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const existing = await this.find(workspaceId, id);
    await this.db.deleteFrom('announcements').where('id', '=', existing.id).execute();
    this.audit.log({
      event: AuditEvent.ANNOUNCEMENT_DELETED,
      resourceType: AuditResource.ANNOUNCEMENT,
      resourceId: existing.id,
      changes: { before: { title: existing.title } },
    });
  }

  // ---- internals ----------------------------------------------------------

  private async find(workspaceId: string, id: string): Promise<Announcement> {
    const row = await this.db
      .selectFrom('announcements')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Announcement not found');
    return row;
  }

  // A field left out of an update keeps its stored value; null clears it.
  private readSchedule(dto: CreateAnnouncementDto, existing: Announcement | null): Schedule {
    const now = Date.now();
    const startsAt =
      dto.startsAt === undefined && existing
        ? new Date(existing.startsAt)
        : dto.startsAt
          ? new Date(dto.startsAt)
          : existing
            ? new Date(existing.startsAt)
            : new Date(now);
    const endsAt =
      dto.endsAt === undefined && existing
        ? existing.endsAt
          ? new Date(existing.endsAt)
          : null
        : dto.endsAt
          ? new Date(dto.endsAt)
          : null;
    if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) {
      throw new BadRequestException('The schedule is not valid');
    }
    if (endsAt) {
      const storedEnd = existing?.endsAt ? new Date(existing.endsAt).getTime() : null;
      const endChanged = storedEnd === null || storedEnd !== endsAt.getTime();
      if (endChanged && endsAt.getTime() <= now) {
        throw new BadRequestException('The end time must be in the future');
      }
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new BadRequestException('The end time must be after the start time');
      }
    }
    return { startsAt, endsAt };
  }

  // Others showing in the same window. Without replace that is a conflict;
  // with it, earlier ones stop when this one starts and this one stops
  // when a later one starts.
  private async resolveOverlap(
    workspaceId: string,
    selfId: string | null,
    schedule: Schedule,
    replace: boolean,
  ): Promise<{ endsAt: Date | null; cutOthers: Announcement[] }> {
    const start = schedule.startsAt.getTime();
    const end = schedule.endsAt?.getTime() ?? Number.POSITIVE_INFINITY;
    let query = this.db
      .selectFrom('announcements')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('archivedAt', 'is', null)
      .where((eb) => eb.or([eb('endsAt', 'is', null), eb('endsAt', '>', new Date())]));
    if (selfId) query = query.where('id', '!=', selfId);
    const others = (await query.execute()).filter((other) => {
      const otherStart = new Date(other.startsAt).getTime();
      const otherEnd = other.endsAt ? new Date(other.endsAt).getTime() : Number.POSITIVE_INFINITY;
      return otherStart < end && otherEnd > start;
    });
    if (others.length === 0) return { endsAt: schedule.endsAt, cutOthers: [] };

    const replaces: Takeover[] = [];
    const replacedBy: Takeover[] = [];
    for (const other of others) {
      const otherStart = new Date(other.startsAt).getTime();
      if (otherStart <= start) replaces.push({ id: other.id, title: other.title, at: schedule.startsAt.toISOString() });
      else replacedBy.push({ id: other.id, title: other.title, at: new Date(other.startsAt).toISOString() });
    }
    if (!replace) {
      throw new ConflictException({
        message: 'Only one announcement can show at a time.',
        conflict: {
          from: schedule.startsAt.toISOString(),
          to: schedule.endsAt ? schedule.endsAt.toISOString() : null,
          announcements: others.map((o) => ({ id: o.id, title: o.title })),
        },
        replaces,
        replacedBy,
      });
    }
    let endsAt = schedule.endsAt;
    for (const later of replacedBy) {
      const at = new Date(later.at);
      if (!endsAt || at.getTime() < endsAt.getTime()) endsAt = at;
    }
    const cutOthers = others.filter((o) => replaces.some((r) => r.id === o.id));
    return { endsAt, cutOthers };
  }

  // Earlier announcements end when the new one starts; one that would end
  // before it began is archived instead.
  private async applyCuts(others: Announcement[], at: Date, user: User) {
    for (const other of others) {
      const otherStart = new Date(other.startsAt).getTime();
      if (at.getTime() <= otherStart) {
        await this.db
          .updateTable('announcements')
          .set({ archivedAt: new Date(), lastUpdatedById: user.id, updatedAt: new Date() })
          .where('id', '=', other.id)
          .execute();
      } else {
        await this.db
          .updateTable('announcements')
          .set({ endsAt: at, lastUpdatedById: user.id, updatedAt: new Date() })
          .where('id', '=', other.id)
          .execute();
      }
    }
  }

  private toView(row: Announcement, nowMs: number): AnnouncementView {
    const startsAt = new Date(row.startsAt);
    const endsAt = row.endsAt ? new Date(row.endsAt) : null;
    const status: AnnouncementStatus = row.archivedAt
      ? 'archived'
      : startsAt.getTime() > nowMs
        ? 'scheduled'
        : endsAt && endsAt.getTime() <= nowMs
          ? 'ended'
          : 'active';
    return {
      id: row.id,
      title: row.title,
      type: row.type as AnnouncementType,
      color: row.color as AnnouncementColor,
      content: asObject(row.content),
      isDismissible: row.isDismissible,
      audience: row.audience as AnnouncementAudience,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
      status,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}

function asObject(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
