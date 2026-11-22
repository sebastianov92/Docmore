import { type Kysely, sql } from 'kysely';

// An import from Notion through its API: what is being brought over, how
// far it is and what it left out. The Notion token is never stored here.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('notion_imports')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('creator_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('space_id', 'uuid', (col) => col.notNull().references('spaces.id').onDelete('cascade'))
    .addColumn('parent_page_id', 'uuid')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued')) // queued | running | done | failed
    .addColumn('progress', 'jsonb')
    .addColumn('report', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('idx_notion_imports_creator').on('notion_imports').columns(['workspace_id', 'creator_id']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('notion_imports').ifExists().execute();
}
