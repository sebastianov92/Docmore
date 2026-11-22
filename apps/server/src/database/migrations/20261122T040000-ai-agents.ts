import { type Kysely, sql } from 'kysely';

// Scheduled agents: a task in words that the model carries out on its own
// on a schedule, as the person who made it, and the record of each run.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_agents')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    // the agent reads and writes with this person's permissions
    .addColumn('creator_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('instructions', 'text', (col) => col.notNull())
    // null: every space the person can see
    .addColumn('space_id', 'uuid', (col) => col.references('spaces.id').onDelete('cascade'))
    .addColumn('schedule', 'jsonb', (col) => col.notNull())
    // where the result goes: a new page each time, added to a page, or only a notification
    .addColumn('output', 'jsonb', (col) => col.notNull())
    // may it create pages and change things on its own, beyond its result
    .addColumn('allow_edits', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('next_run_at', 'timestamptz')
    .addColumn('last_run_at', 'timestamptz')
    .addColumn('last_status', 'varchar')
    .addColumn('last_error', 'text')
    .addColumn('failures', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_ai_agents_owner').on('ai_agents').columns(['workspace_id', 'creator_id']).execute();
  await db.schema.createIndex('idx_ai_agents_due').on('ai_agents').columns(['enabled', 'next_run_at']).execute();

  await db.schema
    .createTable('ai_agent_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('agent_id', 'uuid', (col) => col.notNull().references('ai_agents.id').onDelete('cascade'))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued')) // queued | running | done | failed
    .addColumn('trigger', 'varchar', (col) => col.notNull().defaultTo('schedule')) // schedule | manual
    .addColumn('result', 'text')
    .addColumn('error', 'text')
    // the page the result landed on, the suggestions and pages it made, the tools it used
    .addColumn('page_id', 'uuid')
    .addColumn('details', 'jsonb')
    .addColumn('usage', 'jsonb')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_ai_agent_runs_agent').on('ai_agent_runs').columns(['agent_id', 'created_at']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_agent_runs').ifExists().execute();
  await db.schema.dropTable('ai_agents').ifExists().execute();
}
