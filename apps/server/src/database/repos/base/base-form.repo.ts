import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

export type FormRow = {
  id: string;
  pageId: string;
  workspaceId: string;
  token: string;
  name: string;
  description: string | null;
  fields: any;
  submitLabel: string | null;
  thanksText: string | null;
  enabled: boolean;
  creatorId: string | null;
  submissions: number;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class BaseFormRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByPage(pageId: string, workspaceId: string): Promise<FormRow[]> {
    return (await this.db
      .selectFrom('baseForms')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute()) as any;
  }

  async findById(id: string, workspaceId: string): Promise<FormRow | undefined> {
    return (await this.db.selectFrom('baseForms').selectAll().where('id', '=', id).where('workspaceId', '=', workspaceId).executeTakeFirst()) as any;
  }

  async findByToken(token: string, workspaceId: string): Promise<FormRow | undefined> {
    return (await this.db.selectFrom('baseForms').selectAll().where('token', '=', token).where('workspaceId', '=', workspaceId).executeTakeFirst()) as any;
  }

  async insert(data: Record<string, unknown>): Promise<FormRow> {
    return (await this.db.insertInto('baseForms').values(data as any).returningAll().executeTakeFirstOrThrow()) as any;
  }

  async update(id: string, data: Record<string, unknown>): Promise<FormRow | undefined> {
    return (await this.db.updateTable('baseForms').set({ ...(data as any), updatedAt: new Date() }).where('id', '=', id).returningAll().executeTakeFirst()) as any;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('baseForms').where('id', '=', id).execute();
  }

  async countSubmission(id: string): Promise<void> {
    await this.db.updateTable('baseForms').set({ submissions: sql`submissions + 1` }).where('id', '=', id).execute();
  }
}
