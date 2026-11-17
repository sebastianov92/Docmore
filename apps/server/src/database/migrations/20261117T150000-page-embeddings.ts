import { type Kysely } from 'kysely';
import { ensurePageEmbeddingsSchema } from '../helpers/page-embeddings.schema';

// Storage for semantic search. Skipped, with a warning, on a Postgres
// without pgvector; the server creates the table on a later start once the
// extension is available (see AiEmbeddingService).
export async function up(db: Kysely<any>): Promise<void> {
  const state = await ensurePageEmbeddingsSchema(db);
  if (state === 'no-extension') {
    console.warn(
      'page_embeddings not created: the pgvector extension is not available on this Postgres. ' +
        'AI search needs it; the pgvector/pgvector image ships with it.',
    );
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
