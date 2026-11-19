import { type Kysely, sql } from 'kysely';

// Bases v3: a structure lock on the base page, template rows, and a
// per-base row number (never reused) behind the ID property type.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('base_locked', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable('base_rows')
    .addColumn('is_template', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable('base_rows')
    .addColumn('row_no', 'integer')
    .execute();
  await sql`
    with numbered as (
      select id, row_number() over (partition by page_id order by created_at, id) as rn
      from base_rows
    )
    update base_rows r set row_no = n.rn from numbered n where n.id = r.id
  `.execute(db);
  await db.schema
    .createIndex('idx_base_rows_page_row_no')
    .on('base_rows')
    .columns(['page_id', 'row_no'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_base_rows_page_row_no').execute();
  await db.schema.alterTable('base_rows').dropColumn('row_no').execute();
  await db.schema.alterTable('base_rows').dropColumn('is_template').execute();
  await db.schema.alterTable('pages').dropColumn('base_locked').execute();
}
