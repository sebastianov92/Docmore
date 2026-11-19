import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

export type RowVersion = {
  id: string;
  rowId: string;
  pageId: string;
  workspaceId: string;
  cells: Record<string, unknown>;
  kind: string;
  actorId: string | null;
  createdAt: Date;
};

export type RowVersionListItem = RowVersion & {
  actorName: string | null;
  actorAvatarUrl: string | null;
  rowDeleted: boolean;
};

const KEEP_PER_ROW = 100;

@Injectable()
export class BaseRowVersionRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insertMany(
    versions: Array<{ rowId: string; pageId: string; workspaceId: string; cells: unknown; kind: string; actorId: string | null }>,
  ): Promise<void> {
    if (versions.length === 0) return;
    await this.db
      .insertInto('baseRowVersions')
      .values(versions.map((v) => ({ ...v, cells: v.cells as any })))
      .execute();
    // keep the last versions of each touched row
    for (const rowId of new Set(versions.map((v) => v.rowId))) {
      await sql`
        delete from base_row_versions
        where row_id = ${rowId}
          and id not in (
            select id from base_row_versions where row_id = ${rowId}
            order by created_at desc limit ${KEEP_PER_ROW}
          )`.execute(this.db);
    }
  }

  // One snapshot per live row of the base (before a type conversion).
  async snapshotPage(pageId: string, workspaceId: string, kind: string, actorId: string | null): Promise<number> {
    const res = await sql<{ count: number }>`
      with ins as (
        insert into base_row_versions (row_id, page_id, workspace_id, cells, kind, actor_id)
        select id, page_id, workspace_id, cells, ${kind}, ${actorId}::uuid
        from base_rows
        where page_id = ${pageId} and workspace_id = ${workspaceId} and deleted_at is null
        returning 1
      )
      select count(*)::int as count from ins`.execute(this.db);
    return res.rows[0]?.count ?? 0;
  }

  async findById(id: string, workspaceId: string): Promise<RowVersion | undefined> {
    return (await this.db
      .selectFrom('baseRowVersions')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst()) as RowVersion | undefined;
  }

  async list(opts: {
    pageId: string;
    workspaceId: string;
    rowId?: string;
    before?: Date;
    limit: number;
  }): Promise<RowVersionListItem[]> {
    let q = this.db
      .selectFrom('baseRowVersions as v')
      .leftJoin('users as u', 'u.id', 'v.actorId')
      .leftJoin('baseRows as r', 'r.id', 'v.rowId')
      .select([
        'v.id',
        'v.rowId',
        'v.pageId',
        'v.workspaceId',
        'v.cells',
        'v.kind',
        'v.actorId',
        'v.createdAt',
        'u.name as actorName',
        'u.avatarUrl as actorAvatarUrl',
        sql<boolean>`r.deleted_at is not null`.as('rowDeleted'),
      ])
      .where('v.pageId', '=', opts.pageId)
      .where('v.workspaceId', '=', opts.workspaceId)
      .orderBy('v.createdAt', 'desc')
      .orderBy('v.id', 'desc')
      .limit(opts.limit);
    if (opts.rowId) q = q.where('v.rowId', '=', opts.rowId);
    if (opts.before) q = q.where('v.createdAt', '<', opts.before);
    return (await q.execute()) as unknown as RowVersionListItem[];
  }
}
