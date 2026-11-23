import { type Kysely, sql } from 'kysely';

// Connections to Notion kept for the workspace, so an import does not ask
// for the secret every time. The secret is stored encrypted and never
// handed back.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('notion_connections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('creator_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('name', 'varchar', (col) => col.notNull())
    // encrypted with the app secret
    .addColumn('token', 'text', (col) => col.notNull())
    // the Notion workspace the connection belongs to, as Notion names it
    .addColumn('account', 'varchar')
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_notion_connections_workspace').on('notion_connections').column('workspace_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('notion_connections').ifExists().execute();
}
