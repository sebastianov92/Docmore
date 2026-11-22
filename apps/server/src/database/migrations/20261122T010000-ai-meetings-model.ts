import { type Kysely } from 'kysely';

// A model of its own for meetings (the live list and the final pass), so a
// fast model can keep up with the room while chat keeps the writing model.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_settings').addColumn('meetings', 'jsonb').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_settings').dropColumn('meetings').execute();
}
