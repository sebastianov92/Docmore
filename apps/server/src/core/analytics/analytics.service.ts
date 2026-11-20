import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Workspace } from '@docmost/db/types/entity.types';

export type AnalyticsSettings = { enabled: boolean; anonymous: boolean };

const RETENTION_DAYS = 400;

// Page views per day and viewer; nothing more than counts.
@Injectable()
export class AnalyticsService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  settings(workspace: Pick<Workspace, 'settings'>): AnalyticsSettings {
    const raw = ((workspace?.settings as any)?.analytics ?? {}) as Partial<AnalyticsSettings>;
    return { enabled: raw.enabled !== false, anonymous: raw.anonymous === true };
  }

  async track(page: { id: string; spaceId: string; workspaceId: string }, userId: string, workspace: Workspace): Promise<void> {
    const settings = this.settings(workspace);
    if (!settings.enabled) return;
    const viewerKey = settings.anonymous ? 'anon' : userId;
    await sql`
      insert into page_views (page_id, space_id, workspace_id, viewer_key, day, views, last_viewed_at)
      values (${page.id}, ${page.spaceId}, ${page.workspaceId}, ${viewerKey}, current_date, 1, now())
      on conflict (page_id, viewer_key, day)
      do update set views = page_views.views + 1, last_viewed_at = now()`.execute(this.db);
    if (Math.random() < 0.01) {
      await sql`delete from page_views where day < current_date - ${RETENTION_DAYS}::int`.execute(this.db);
    }
  }

  async pageStats(pageId: string, days = 30) {
    const since = sql`current_date - ${days}::int`;
    const byDay = await sql<{ day: string; views: number; viewers: number }>`
      select to_char(day, 'YYYY-MM-DD') as day, sum(views)::int as views, count(distinct viewer_key)::int as viewers
      from page_views where page_id = ${pageId} and day >= ${since}
      group by day order by day`.execute(this.db);
    const totals = await sql<{ views: number; viewers: number; last: Date | null }>`
      select coalesce(sum(views), 0)::int as views, count(distinct viewer_key)::int as viewers, max(last_viewed_at) as last
      from page_views where page_id = ${pageId} and day >= ${since}`.execute(this.db);
    const allTime = await sql<{ views: number }>`select coalesce(sum(views), 0)::int as views from page_views where page_id = ${pageId}`.execute(this.db);
    const viewers = await sql<{ userId: string; name: string | null; avatarUrl: string | null; views: number; last: Date }>`
      select v.viewer_key as "userId", u.name, u.avatar_url as "avatarUrl", sum(v.views)::int as views, max(v.last_viewed_at) as last
      from page_views v left join users u on u.id::text = v.viewer_key
      where v.page_id = ${pageId} and v.day >= ${since} and v.viewer_key <> 'anon'
      group by v.viewer_key, u.name, u.avatar_url order by last desc limit 20`.execute(this.db);
    return {
      days,
      views: totals.rows[0]?.views ?? 0,
      uniqueViewers: totals.rows[0]?.viewers ?? 0,
      lastViewedAt: totals.rows[0]?.last ?? null,
      allTimeViews: allTime.rows[0]?.views ?? 0,
      byDay: byDay.rows,
      viewers: viewers.rows,
    };
  }

  async workspaceStats(workspaceId: string, days = 30, spaceId?: string) {
    const since = sql`current_date - ${days}::int`;
    const scope = spaceId ? sql`and v.space_id = ${spaceId}` : sql``;
    const byDay = await sql<{ day: string; views: number; viewers: number }>`
      select to_char(v.day, 'YYYY-MM-DD') as day, sum(v.views)::int as views, count(distinct v.viewer_key)::int as viewers
      from page_views v where v.workspace_id = ${workspaceId} and v.day >= ${since} ${scope}
      group by v.day order by v.day`.execute(this.db);
    const topPages = await sql<{ pageId: string; title: string | null; slugId: string; spaceSlug: string; spaceName: string | null; views: number; viewers: number }>`
      select v.page_id as "pageId", p.title, p.slug_id as "slugId", s.slug as "spaceSlug", s.name as "spaceName",
             sum(v.views)::int as views, count(distinct v.viewer_key)::int as viewers
      from page_views v join pages p on p.id = v.page_id join spaces s on s.id = p.space_id
      where v.workspace_id = ${workspaceId} and v.day >= ${since} and p.deleted_at is null ${scope}
      group by v.page_id, p.title, p.slug_id, s.slug, s.name order by views desc limit 20`.execute(this.db);
    const stalePages = await sql<{ pageId: string; title: string | null; slugId: string; spaceSlug: string; spaceName: string | null; updatedAt: Date; lastViewedAt: Date | null }>`
      select p.id as "pageId", p.title, p.slug_id as "slugId", s.slug as "spaceSlug", s.name as "spaceName", p.updated_at as "updatedAt",
             (select max(last_viewed_at) from page_views pv where pv.page_id = p.id) as "lastViewedAt"
      from pages p join spaces s on s.id = p.space_id
      where p.workspace_id = ${workspaceId} and p.deleted_at is null and s.deleted_at is null
        and p.updated_at < now() - interval '90 days'
        ${spaceId ? sql`and p.space_id = ${spaceId}` : sql``}
        and not exists (select 1 from page_views pv where pv.page_id = p.id and pv.day >= current_date - 90)
      order by p.updated_at asc limit 20`.execute(this.db);
    const totals = await sql<{ views: number; viewers: number; pages: number }>`
      select coalesce(sum(v.views), 0)::int as views, count(distinct v.viewer_key)::int as viewers, count(distinct v.page_id)::int as pages
      from page_views v where v.workspace_id = ${workspaceId} and v.day >= ${since} ${scope}`.execute(this.db);
    return {
      days,
      views: totals.rows[0]?.views ?? 0,
      activeViewers: totals.rows[0]?.viewers ?? 0,
      pagesViewed: totals.rows[0]?.pages ?? 0,
      byDay: byDay.rows,
      topPages: topPages.rows,
      stalePages: stalePages.rows,
    };
  }
}
