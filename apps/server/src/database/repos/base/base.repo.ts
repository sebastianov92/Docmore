import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql, ExpressionBuilder } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';

import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import { DB } from '@docmost/db/types/db';
import { Page } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

export type BasePage = Page & {
  properties?: unknown[];
  views?: unknown[];
};

@Injectable()
export class BaseRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // Copies a base's schema, views and rows onto another page (page
  // duplication). Property ids are kept: they are unique per base, and
  // formulas and view configs refer to them.
  async copyBaseData(
    fromPageId: string,
    toPageId: string,
    userId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await sql`
      insert into base_properties (id, page_id, name, type, position, type_options, is_primary, schema_version, workspace_id)
      select id, ${toPageId}::uuid, name, type, position, type_options, is_primary, schema_version, workspace_id
      from base_properties where page_id = ${fromPageId}::uuid and deleted_at is null
    `.execute(db);
    await sql`
      insert into base_views (page_id, name, type, position, config, workspace_id, creator_id)
      select ${toPageId}::uuid, name, type, position, config, workspace_id, ${userId}::uuid
      from base_views where page_id = ${fromPageId}::uuid
    `.execute(db);
    await sql`
      insert into base_rows (page_id, cells, position, creator_id, last_updated_by_id, workspace_id, row_no, is_template, blocked_by)
      select ${toPageId}::uuid, cells, position, ${userId}::uuid, ${userId}::uuid, workspace_id, row_no, is_template, '[]'::jsonb
      from base_rows where page_id = ${fromPageId}::uuid and deleted_at is null
    `.execute(db);
    await sql`
      update pages set base_schema_version = (select base_schema_version from pages where id = ${fromPageId}::uuid)
      where id = ${toPageId}::uuid
    `.execute(db);
  }

  // The "base id" is the page id of an is_base=true page.
  async findById(
    pageId: string,
    opts?: {
      includeProperties?: boolean;
      includeViews?: boolean;
      trx?: KyselyTransaction;
    },
  ): Promise<BasePage | undefined> {
    const db = dbOrTx(this.db, opts?.trx);

    let query = db
      .selectFrom('pages')
      .selectAll('pages')
      .where('id', '=', pageId)
      .where('isBase', '=', true)
      .where('deletedAt', 'is', null);

    if (opts?.includeProperties) {
      query = query.select((eb) => this.withProperties(eb));
    }
    if (opts?.includeViews) {
      query = query.select((eb) => this.withViews(eb));
    }

    return query.executeTakeFirst() as Promise<BasePage | undefined>;
  }

  async findBySpaceId(
    spaceId: string,
    pagination: PaginationOptions,
    opts?: { trx?: KyselyTransaction },
  ) {
    const db = dbOrTx(this.db, opts?.trx);

    const query = db
      .selectFrom('pages')
      .selectAll('pages')
      .where('spaceId', '=', spaceId)
      .where('isBase', '=', true)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'createdAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });
  }

  async softDelete(pageId: string, trx?: KyselyTransaction): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('pages')
      .set({ deletedAt: new Date() })
      .where('id', '=', pageId)
      .where('isBase', '=', true)
      .execute();
  }

  async bumpSchemaVersion(
    pageId: string,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const db = dbOrTx(this.db, trx);
    const result = await db
      .updateTable('pages')
      .set({
        baseSchemaVersion: sql`base_schema_version + 1`,
        updatedAt: new Date(),
      })
      .where('id', '=', pageId)
      .where('isBase', '=', true)
      .returning('baseSchemaVersion')
      .executeTakeFirst();
    return result?.baseSchemaVersion ?? 0;
  }

  private withProperties(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('baseProperties')
        .selectAll('baseProperties')
        .whereRef('baseProperties.pageId', '=', 'pages.id')
        .where('baseProperties.deletedAt', 'is', null)
        .orderBy('baseProperties.position', 'asc'),
    ).as('properties');
  }

  private withViews(eb: ExpressionBuilder<DB, 'pages'>) {
    return jsonArrayFrom(
      eb
        .selectFrom('baseViews')
        .selectAll('baseViews')
        .whereRef('baseViews.pageId', '=', 'pages.id')
        .orderBy('baseViews.position', 'asc'),
    ).as('views');
  }
}
