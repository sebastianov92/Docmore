import { type Kysely, sql } from 'kysely';

// Per-person AI limits (ai_settings.limits) and a daily usage counter.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_settings').addColumn('limits', 'jsonb').execute();
  await db.schema
    .createTable('ai_usage')
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('day', 'date', (col) => col.notNull())
    .addColumn('requests', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('ai_usage_pkey', ['workspace_id', 'user_id', 'day'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_usage').execute();
  await db.schema.alterTable('ai_settings').dropColumn('limits').execute();
}
