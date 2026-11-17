import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { AuditListDto } from './dto/audit.dto';

export interface AuditResourceRef {
  id: string;
  name: string;
  slug?: string;
  slugId?: string;
  spaceSlug?: string;
}

// Reads the audit trail for the settings page: newest first, filterable,
// with the actor and a human name for the resource attached.
@Injectable()
export class AuditQueryService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async list(workspaceId: string, dto: AuditListDto) {
    const limit = Math.min(Math.max(dto.limit ?? 50, 1), 100);

    const query = this.db
      .selectFrom('audit')
      .select([
        'audit.id',
        'audit.workspaceId',
        'audit.actorId',
        'audit.actorType',
        'audit.event',
        'audit.resourceType',
        'audit.resourceId',
        'audit.spaceId',
        'audit.changes',
        'audit.metadata',
        'audit.ipAddress',
        'audit.userAgent',
        'audit.createdAt',
      ])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select(['users.id', 'users.name', 'users.email', 'users.avatarUrl'])
            .whereRef('users.id', '=', 'audit.actorId'),
        ).as('actor'),
      )
      .where('audit.workspaceId', '=', workspaceId)
      .$if(Boolean(dto.event), (qb) => qb.where('audit.event', '=', dto.event))
      .$if(Boolean(dto.resourceType), (qb) =>
        qb.where('audit.resourceType', '=', dto.resourceType),
      )
      .$if(Boolean(dto.actorId), (qb) => qb.where('audit.actorId', '=', dto.actorId))
      .$if(Boolean(dto.spaceId), (qb) => qb.where('audit.spaceId', '=', dto.spaceId))
      .$if(Boolean(dto.startDate), (qb) =>
        qb.where('audit.createdAt', '>=', new Date(dto.startDate)),
      )
      .$if(Boolean(dto.endDate), (qb) =>
        qb.where('audit.createdAt', '<=', endOfDay(dto.endDate)),
      );

    // Ids are uuid v7, so ordering by id is ordering by time.
    const result = await executeWithCursorPagination(query, {
      perPage: limit,
      cursor: dto.cursor,
      beforeCursor: dto.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });

    const resources = await this.resolveResources(result.items as any[]);
    const items = (result.items as any[]).map((row) => ({
      ...row,
      resource:
        (row.resourceId && resources.get(`${row.resourceType}:${row.resourceId}`)) ||
        fallbackResource(row) ||
        null,
    }));

    return { items, meta: result.meta };
  }

  async retentionDays(workspaceId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('auditRetentionDays')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const days = row?.auditRetentionDays;
    return days === null || days === undefined ? null : Number(days);
  }

  // Looks up current names for the resources on this page, one query per
  // kind. Deleted resources fall back to what the row recorded.
  private async resolveResources(rows: any[]): Promise<Map<string, AuditResourceRef>> {
    const out = new Map<string, AuditResourceRef>();
    const idsByType = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.resourceId) continue;
      const type = row.resourceType === 'space_member' ? 'space' : row.resourceType;
      const set = idsByType.get(type) ?? new Set<string>();
      set.add(row.resourceId);
      idsByType.set(type, set);
    }
    const put = (type: string, id: string, ref: AuditResourceRef) => {
      out.set(`${type}:${id}`, ref);
      if (type === 'space') out.set(`space_member:${id}`, ref);
    };

    const ids = (type: string) => [...(idsByType.get(type) ?? [])];

    if (ids('page').length) {
      const pages = await this.db
        .selectFrom('pages')
        .leftJoin('spaces', 'spaces.id', 'pages.spaceId')
        .select(['pages.id', 'pages.title', 'pages.slugId', 'spaces.slug as spaceSlug'])
        .where('pages.id', 'in', ids('page'))
        .execute();
      for (const p of pages) {
        put('page', p.id, {
          id: p.id,
          name: p.title || 'Untitled',
          slugId: p.slugId,
          spaceSlug: p.spaceSlug ?? undefined,
        });
      }
    }
    if (ids('space').length) {
      const spaces = await this.db
        .selectFrom('spaces')
        .select(['id', 'name', 'slug'])
        .where('id', 'in', ids('space'))
        .execute();
      for (const s of spaces) put('space', s.id, { id: s.id, name: s.name, slug: s.slug });
    }
    if (ids('user').length) {
      const users = await this.db
        .selectFrom('users')
        .select(['id', 'name', 'email'])
        .where('id', 'in', ids('user'))
        .execute();
      for (const u of users) put('user', u.id, { id: u.id, name: u.name || u.email });
    }
    if (ids('group').length) {
      const groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name'])
        .where('id', 'in', ids('group'))
        .execute();
      for (const g of groups) put('group', g.id, { id: g.id, name: g.name });
    }
    if (ids('api_key').length) {
      const keys = await this.db
        .selectFrom('apiKeys')
        .select(['id', 'name'])
        .where('id', 'in', ids('api_key'))
        .execute();
      for (const k of keys) put('api_key', k.id, { id: k.id, name: k.name });
    }
    if (ids('sso_provider').length) {
      const providers = await this.db
        .selectFrom('authProviders')
        .select(['id', 'name'])
        .where('id', 'in', ids('sso_provider'))
        .execute();
      for (const p of providers) put('sso_provider', p.id, { id: p.id, name: p.name });
    }
    if (ids('template').length) {
      const templates = await this.db
        .selectFrom('templates')
        .select(['id', 'title'])
        .where('id', 'in', ids('template'))
        .execute();
      for (const t of templates) put('template', t.id, { id: t.id, name: t.title || 'Untitled' });
    }
    if (ids('attachment').length) {
      const files = await this.db
        .selectFrom('attachments')
        .select(['id', 'fileName'])
        .where('id', 'in', ids('attachment'))
        .execute();
      for (const f of files) put('attachment', f.id, { id: f.id, name: f.fileName });
    }
    if (ids('workspace').length) {
      const workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'name'])
        .where('id', 'in', ids('workspace'))
        .execute();
      for (const w of workspaces) put('workspace', w.id, { id: w.id, name: w.name });
    }
    if (ids('workspace_invitation').length) {
      const invites = await this.db
        .selectFrom('workspaceInvitations')
        .select(['id', 'email'])
        .where('id', 'in', ids('workspace_invitation'))
        .execute();
      for (const i of invites) put('workspace_invitation', i.id, { id: i.id, name: i.email });
    }

    return out;
  }
}

// Comments and shares carry the page title in their metadata; deleted
// things usually left their name in changes.before.
function fallbackResource(row: any): AuditResourceRef | undefined {
  const before = row.changes?.before ?? {};
  const after = row.changes?.after ?? {};
  const meta = row.metadata ?? {};
  const name =
    before.name ?? before.title ?? after.name ?? after.title ??
    meta.name ?? meta.title ?? meta.pageTitle ?? meta.fileName ?? meta.email ??
    before.email ?? after.email ?? null;
  if (!name) return undefined;
  return { id: row.resourceId ?? '', name: String(name) };
}

function endOfDay(value: string): Date {
  const date = new Date(value);
  // A bare date means "that whole day"; a timestamp is used as given.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}
