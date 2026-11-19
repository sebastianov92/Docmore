import { type Kysely, sql } from 'kysely';

// Comments on a row, who may see a column, and cell snapshots to restore.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('comments')
    .addColumn('base_row_id', 'uuid', (col) => col.references('base_rows.id').onDelete('cascade'))
    .execute();
  await db.schema.createIndex('idx_comments_base_row_id').on('comments').column('base_row_id').execute();

  await db.schema
    .alterTable('base_properties')
    .addColumn('restricted_to', 'varchar', (col) => col.notNull().defaultTo('all'))
    .execute();

  await db.schema
    .createTable('base_row_versions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('row_id', 'uuid', (col) => col.notNull().references('base_rows.id').onDelete('cascade'))
    .addColumn('page_id', 'uuid', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('cells', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('kind', 'varchar', (col) => col.notNull())
    .addColumn('actor_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('idx_base_row_versions_page_created')
    .on('base_row_versions')
    .columns(['page_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('idx_base_row_versions_row_created')
    .on('base_row_versions')
    .columns(['row_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('base_row_versions').execute();
  await db.schema.alterTable('base_properties').dropColumn('restricted_to').execute();
  await db.schema.dropIndex('idx_comments_base_row_id').execute();
  await db.schema.alterTable('comments').dropColumn('base_row_id').execute();
}
