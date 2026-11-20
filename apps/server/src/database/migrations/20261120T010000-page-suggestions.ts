import { type Kysely, sql } from 'kysely';

// Suggested edits: a proposed version of a page that an editor accepts or
// rejects, so readers and commenters can contribute without edit rights.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('page_suggestions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('space_id', 'uuid', (col) => col.notNull())
    .addColumn('page_id', 'uuid', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('author_id', 'uuid', (col) => col.notNull())
    .addColumn('title', 'varchar')
    .addColumn('note', 'text')
    .addColumn('base_content', 'jsonb')
    .addColumn('content', 'jsonb', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('open')) // open | accepted | rejected | withdrawn
    .addColumn('reviewer_id', 'uuid')
    .addColumn('review_note', 'text')
    .addColumn('reviewed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_page_suggestions_page').on('page_suggestions').columns(['page_id', 'status']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_suggestions').ifExists().execute();
}
