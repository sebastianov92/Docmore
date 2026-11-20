import { type Kysely, sql } from 'kysely';

// Guests and admin scopes on users, a public hostname per space, and the
// page view counters behind analytics.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').addColumn('admin_scopes', 'jsonb').execute();
  await db.schema.alterTable('spaces').addColumn('public_hostname', 'varchar').execute();
  await db.schema.createIndex('idx_spaces_public_hostname').on('spaces').column('public_hostname').unique().execute();

  await db.schema
    .createTable('page_views')
    .addColumn('page_id', 'uuid', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('space_id', 'uuid', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    // a user id, or 'anon' when the workspace keeps no names
    .addColumn('viewer_key', 'varchar', (col) => col.notNull())
    .addColumn('day', 'date', (col) => col.notNull())
    .addColumn('views', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('last_viewed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('page_views_pkey', ['page_id', 'viewer_key', 'day'])
    .execute();
  await db.schema.createIndex('idx_page_views_workspace_day').on('page_views').columns(['workspace_id', 'day']).execute();
  await db.schema.createIndex('idx_page_views_space_day').on('page_views').columns(['space_id', 'day']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_views').execute();
  await db.schema.dropIndex('idx_spaces_public_hostname').execute();
  await db.schema.alterTable('spaces').dropColumn('public_hostname').execute();
  await db.schema.alterTable('users').dropColumn('admin_scopes').execute();
}
