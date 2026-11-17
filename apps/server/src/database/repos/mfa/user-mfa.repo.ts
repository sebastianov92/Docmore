import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Insertable, Selectable, Updateable } from 'kysely';
import { KyselyDB } from '../../types/kysely.types';
import { UserMfa as UserMfaTable } from '@docmost/db/types/db';

export type UserMfaRow = Selectable<UserMfaTable>;
export type InsertableUserMfa = Insertable<UserMfaTable>;
export type UpdatableUserMfa = Updateable<Omit<UserMfaTable, 'id'>>;

@Injectable()
export class UserMfaRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByUserId(
    userId: string,
    workspaceId: string,
  ): Promise<UserMfaRow | undefined> {
    return this.db
      .selectFrom('userMfa')
      .selectAll()
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  // One row per user: a new setup replaces whatever was pending or enabled.
  async upsert(data: InsertableUserMfa): Promise<UserMfaRow> {
    return this.db
      .insertInto('userMfa')
      .values(data)
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({
          method: data.method,
          secret: data.secret,
          isEnabled: data.isEnabled,
          backupCodes: data.backupCodes,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(
    userId: string,
    workspaceId: string,
    data: UpdatableUserMfa,
  ): Promise<UserMfaRow | undefined> {
    return this.db
      .updateTable('userMfa')
      .set({ ...data, updatedAt: new Date() })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
  }

  async deleteByUserId(userId: string, workspaceId: string): Promise<void> {
    await this.db
      .deleteFrom('userMfa')
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }
}
