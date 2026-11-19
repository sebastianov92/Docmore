import { type Kysely, sql } from 'kysely';

// Closed spaces take join requests; members can ask admins to invite
// someone. Both land in small request tables reviewed by admins.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('space_join_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('space_id', 'uuid', (col) => col.notNull().references('spaces.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('note', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending'))
    .addColumn('reviewed_by_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('reviewed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create unique index idx_space_join_requests_pending on space_join_requests (space_id, user_id) where status = 'pending'`.execute(db);

  await db.schema
    .createTable('workspace_invite_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('requester_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('email', 'varchar', (col) => col.notNull())
    .addColumn('note', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending'))
    .addColumn('reviewed_by_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('reviewed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`create unique index idx_workspace_invite_requests_pending on workspace_invite_requests (workspace_id, lower(email)) where status = 'pending'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('workspace_invite_requests').execute();
  await db.schema.dropTable('space_join_requests').execute();
}
