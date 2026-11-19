import { type Kysely, sql } from 'kysely';

// Sub-items (parent row in the same base) and dependencies (blocked by).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('base_rows')
    .addColumn('parent_row_id', 'uuid', (col) => col.references('base_rows.id').onDelete('set null'))
    .execute();
  await db.schema
    .alterTable('base_rows')
    .addColumn('blocked_by', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
  await db.schema
    .createIndex('idx_base_rows_parent_row_id')
    .on('base_rows')
    .column('parent_row_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_base_rows_parent_row_id').execute();
  await db.schema.alterTable('base_rows').dropColumn('blocked_by').execute();
  await db.schema.alterTable('base_rows').dropColumn('parent_row_id').execute();
}
