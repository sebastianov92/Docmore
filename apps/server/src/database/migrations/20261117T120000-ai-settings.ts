import { Kysely, sql } from 'kysely';

// Provider credentials and model choices for the built-in AI. Kept apart
// from workspaces.settings, which every client receives.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_settings')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (col) =>
      col.primaryKey().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('providers', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('generation', 'jsonb')
    .addColumn('embedding', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ai_settings').ifExists().execute();
}
