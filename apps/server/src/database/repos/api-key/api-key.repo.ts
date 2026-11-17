import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ExpressionBuilder, sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '../../types/kysely.types';
import { DB, Json } from '@docmost/db/types/db';
import {
  ApiKey,
  InsertableApiKey,
  UpdatableApiKey,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof ApiKey> = [
    'id',
    'name',
    'scopes',
    'creatorId',
    'workspaceId',
    'expiresAt',
    'lastUsedAt',
    'createdAt',
    'updatedAt',
  ];

  async findById(apiKeyId: string, workspaceId: string) {
    return this.db
      .selectFrom('apiKeys')
      .select(this.baseFields)
      .select((eb) => this.withCreator(eb))
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async insert(data: Omit<InsertableApiKey, 'scopes'> & { scopes: string[] }) {
    return this.db
      .insertInto('apiKeys')
      .values({
        ...data,
        // node-pg would send a JS array as a Postgres array, not as JSON.
        scopes: sql<Json>`${JSON.stringify(data.scopes)}::text::jsonb`,
      })
      .returning(this.baseFields)
      .executeTakeFirstOrThrow();
  }

  async update(apiKeyId: string, workspaceId: string, data: UpdatableApiKey) {
    return this.db
      .updateTable('apiKeys')
      .set({ ...data, updatedAt: new Date() })
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async touchLastUsed(apiKeyId: string) {
    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', apiKeyId)
      .execute();
  }

  async softDelete(apiKeyId: string, workspaceId: string) {
    const result = await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async paginate(
    opts: { workspaceId: string; creatorId?: string },
    pagination: PaginationOptions,
  ) {
    let query = this.db
      .selectFrom('apiKeys')
      .select(this.baseFields)
      .select((eb) => this.withCreator(eb))
      .where('workspaceId', '=', opts.workspaceId)
      .where('deletedAt', 'is', null);

    if (opts.creatorId) {
      query = query.where('creatorId', '=', opts.creatorId);
    }

    if (pagination.query) {
      query = query.where('name', 'ilike', `%${pagination.query}%`);
    }

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

  private withCreator(eb: ExpressionBuilder<DB, 'apiKeys'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl', 'users.email'])
        .whereRef('users.id', '=', 'apiKeys.creatorId'),
    ).as('creator');
  }
}
