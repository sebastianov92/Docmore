import { type Kysely, sql } from 'kysely';

// A private link per person and view that calendar apps subscribe to: the
// rows of a base's calendar view as an .ics feed.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('base_calendar_feeds')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('page_id', 'uuid', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('view_id', 'uuid', (col) => col.notNull().references('base_views.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    // the secret in the address; its owner can look it up again to add the
    // calendar on another device
    .addColumn('token', 'varchar', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_read_at', 'timestamptz')
    .addUniqueConstraint('base_calendar_feeds_view_user', ['view_id', 'user_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('base_calendar_feeds').ifExists().execute();
}
