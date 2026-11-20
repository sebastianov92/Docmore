import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { BasePropertyType } from '../base.schemas';

export interface MyWorkItem {
  rowId: string;
  pageId: string;
  title: string;
  pageTitle: string;
  url: string;
  status: { name: string; color: string | null } | null;
  date: string | null;
  updatedAt: string;
}

const MAX_ROWS = 400;

// What a member has on their plate across every base they can read: rows
// where a person property names them, split into open tasks and the ones
// dated in the next days.
@Injectable()
export class BaseMyWorkService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMembers: SpaceMemberRepo,
  ) {}

  async forUser(userId: string, workspaceId: string, days = 7): Promise<{ tasks: MyWorkItem[]; upcoming: MyWorkItem[] }> {
    const spaceIds = await this.spaceMembers.getUserSpaceIds(userId);
    if (spaceIds.length === 0) return { tasks: [], upcoming: [] };
    const rows = await sql<{ id: string; pageId: string; cells: Record<string, unknown>; updatedAt: Date; pageTitle: string | null; slugId: string; spaceSlug: string }>`
      select r.id, r.page_id as "pageId", r.cells, r.updated_at as "updatedAt", p.title as "pageTitle", p.slug_id as "slugId", s.slug as "spaceSlug"
      from base_rows r
      join pages p on p.id = r.page_id and p.deleted_at is null
      join spaces s on s.id = p.space_id
      where r.workspace_id = ${workspaceId}
        and r.deleted_at is null and r.is_template = false
        and p.space_id = any(${spaceIds}::uuid[])
        and exists (
          select 1 from base_properties bp
          where bp.page_id = r.page_id and bp.deleted_at is null and bp.type = ${BasePropertyType.PERSON}
            and (
              (jsonb_typeof(r.cells->bp.id) = 'array' and r.cells->bp.id ? ${userId})
              or r.cells->>bp.id = ${userId}
            )
        )
      order by r.updated_at desc
      limit ${MAX_ROWS}
    `.execute(this.db);
    if (rows.rows.length === 0) return { tasks: [], upcoming: [] };
    const pageIds = [...new Set(rows.rows.map((r) => r.pageId))];
    const props = await this.db
      .selectFrom('baseProperties')
      .select(['id', 'pageId', 'type', 'typeOptions', 'isPrimary'])
      .where('pageId', 'in', pageIds)
      .where('deletedAt', 'is', null)
      .execute();
    const byPage = new Map<string, typeof props>();
    for (const p of props) byPage.set(p.pageId, [...(byPage.get(p.pageId) ?? []), p]);

    const now = Date.now();
    const horizon = now + days * 24 * 60 * 60 * 1000;
    const tasks: MyWorkItem[] = [];
    const upcoming: MyWorkItem[] = [];
    for (const r of rows.rows) {
      const list = byPage.get(r.pageId) ?? [];
      const primary = list.find((p) => p.isPrimary);
      const cells = (r.cells ?? {}) as Record<string, unknown>;
      let done = false;
      let status: MyWorkItem['status'] = null;
      for (const p of list.filter((x) => x.type === BasePropertyType.STATUS)) {
        const id = cells[p.id];
        const choice = ((p.typeOptions as any)?.choices ?? []).find((c: any) => c.id === id);
        if (choice) {
          status = { name: choice.name, color: choice.color ?? null };
          if (choice.category === 'complete') done = true;
        }
      }
      for (const p of list.filter((x) => x.type === BasePropertyType.CHECKBOX)) {
        if (cells[p.id] === true && /done|complete|hecho|listo/i.test((p as any).name ?? '')) done = true;
      }
      let date: string | null = null;
      for (const p of list.filter((x) => x.type === BasePropertyType.DATE)) {
        const v = cells[p.id];
        const d = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as any).start === 'string' ? (v as any).start : null;
        if (d && (!date || d < date)) date = d;
      }
      const item: MyWorkItem = {
        rowId: r.id,
        pageId: r.pageId,
        title: String(primary ? (cells[primary.id] ?? '') : '').trim() || 'Untitled',
        pageTitle: r.pageTitle || 'Untitled',
        url: `/s/${r.spaceSlug}/p/${r.slugId}`,
        status,
        date,
        updatedAt: new Date(r.updatedAt).toISOString(),
      };
      if (!done) tasks.push(item);
      if (date) {
        const t = new Date(date).getTime();
        if (t >= now - 24 * 60 * 60 * 1000 && t <= horizon) upcoming.push(item);
      }
    }
    tasks.sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
    upcoming.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return { tasks: tasks.slice(0, 50), upcoming: upcoming.slice(0, 50) };
  }
}
