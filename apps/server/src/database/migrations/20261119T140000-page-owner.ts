import { type Kysely, sql } from 'kysely';

// Pages get an editable owner, seeded from the creator.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('owner_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .execute();
  await sql`update pages set owner_id = creator_id where owner_id is null`.execute(db);
  await db.schema
    .createIndex('idx_pages_owner_id')
    .on('pages')
    .column('owner_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_pages_owner_id').execute();
  await db.schema.alterTable('pages').dropColumn('owner_id').execute();
}
