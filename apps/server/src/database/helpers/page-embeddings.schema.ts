import { Kysely, sql } from 'kysely';

export type PageEmbeddingsSchemaState = 'ready' | 'no-extension';

// Creates the pgvector extension and the page_embeddings table. Idempotent,
// and it must run inside a transaction: a failed CREATE EXTENSION aborts the
// transaction, so the attempt is wrapped in a savepoint. Returns
// 'no-extension' when the database server has no pgvector, so the caller can
// carry on without semantic search instead of failing to start.
export async function ensurePageEmbeddingsSchema(
  db: Kysely<any>,
): Promise<PageEmbeddingsSchemaState> {
  const available = await sql<{ name: string }>`
    SELECT name FROM pg_available_extensions WHERE name = 'vector'
  `.execute(db);
  if (available.rows.length === 0) {
    return 'no-extension';
  }

  await sql`SAVEPOINT page_embeddings_ext`.execute(db);
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
    await sql`RELEASE SAVEPOINT page_embeddings_ext`.execute(db);
  } catch {
    await sql`ROLLBACK TO SAVEPOINT page_embeddings_ext`.execute(db);
    return 'no-extension';
  }

  // The embedding column has no fixed dimension count so a workspace can
  // move to another model; queries filter on model_dimensions and compare
  // exactly, which is fast enough for a homelab's worth of pages.
  await db.schema
    .createTable('page_embeddings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('space_id', 'uuid', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('attachment_id', 'uuid', (col) => col)
    .addColumn('model_name', 'varchar', (col) => col.notNull())
    .addColumn('model_dimensions', 'integer', (col) => col.notNull())
    .addColumn('embedding', sql`vector`, (col) => col.notNull())
    .addColumn('chunk_index', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_start', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('chunk_length', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('metadata', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    .execute();

  await db.schema
    .createIndex('idx_page_embeddings_page_id')
    .ifNotExists()
    .on('page_embeddings')
    .column('page_id')
    .execute();
  await db.schema
    .createIndex('idx_page_embeddings_workspace_model')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id', 'model_name', 'model_dimensions'])
    .execute();
  await db.schema
    .createIndex('idx_page_embeddings_space_id')
    .ifNotExists()
    .on('page_embeddings')
    .column('space_id')
    .execute();

  return 'ready';
}
