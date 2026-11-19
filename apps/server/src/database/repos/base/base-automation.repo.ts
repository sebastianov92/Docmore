import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

export type AutomationRow = {
  id: string;
  pageId: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  trigger: any;
  conditions: any;
  actions: any;
  creatorId: string | null;
  runCount: number;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class BaseAutomationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByPage(pageId: string, workspaceId: string): Promise<AutomationRow[]> {
    return (await this.db
      .selectFrom('baseAutomations')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute()) as any;
  }

  async findEnabledByPage(pageId: string): Promise<AutomationRow[]> {
    return (await this.db
      .selectFrom('baseAutomations')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('enabled', '=', true)
      .orderBy('createdAt', 'asc')
      .execute()) as any;
  }

  async findById(id: string, workspaceId: string): Promise<AutomationRow | undefined> {
    return (await this.db
      .selectFrom('baseAutomations')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst()) as any;
  }

  async insert(data: {
    pageId: string;
    workspaceId: string;
    name: string;
    enabled: boolean;
    trigger: unknown;
    conditions: unknown | null;
    actions: unknown;
    creatorId: string | null;
  }): Promise<AutomationRow> {
    return (await this.db
      .insertInto('baseAutomations')
      .values({ ...data, trigger: data.trigger as any, conditions: data.conditions as any, actions: data.actions as any })
      .returningAll()
      .executeTakeFirstOrThrow()) as any;
  }

  async update(id: string, data: Partial<{ name: string; enabled: boolean; trigger: unknown; conditions: unknown | null; actions: unknown }>): Promise<AutomationRow | undefined> {
    return (await this.db
      .updateTable('baseAutomations')
      .set({ ...(data as any), updatedAt: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()) as any;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('baseAutomations').where('id', '=', id).execute();
  }

  async recordRun(automationId: string, rowId: string | null, status: 'ok' | 'error', error: string | null): Promise<void> {
    await this.db.insertInto('baseAutomationRuns').values({ automationId, rowId, status, error }).execute();
    await this.db
      .updateTable('baseAutomations')
      .set({
        runCount: sql`run_count + 1`,
        lastRunAt: new Date(),
        lastError: error,
      })
      .where('id', '=', automationId)
      .execute();
    await sql`
      delete from base_automation_runs
      where automation_id = ${automationId}
        and id not in (
          select id from base_automation_runs where automation_id = ${automationId}
          order by created_at desc limit 100
        )`.execute(this.db);
  }

  async listRuns(automationId: string, limit: number) {
    return this.db
      .selectFrom('baseAutomationRuns')
      .selectAll()
      .where('automationId', '=', automationId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute();
  }
}
