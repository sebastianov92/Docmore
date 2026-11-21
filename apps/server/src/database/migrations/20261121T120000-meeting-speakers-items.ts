import { type Kysely, sql } from 'kysely';

// Meetings with a kind (in person / virtual), speakers that can be named,
// and the list of agreements and tasks kept while the meeting runs.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('ai_meeting_notes')
    .addColumn('mode', 'varchar') // in_person | virtual
    .addColumn('speakers', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('items', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('items_revision', 'integer', (col) => col.notNull().defaultTo(0))
    // how many segments the model has read for the live list
    .addColumn('live_cursor', 'integer', (col) => col.notNull().defaultTo(0))
    // title, summary, topics, the language of the headings and the ids of the
    // first and last block of the notes on the page
    .addColumn('notes', 'jsonb')
    .execute();
  await db.schema.createIndex('idx_ai_meeting_notes_page').on('ai_meeting_notes').columns(['page_id']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_ai_meeting_notes_page').ifExists().execute();
  await db.schema
    .alterTable('ai_meeting_notes')
    .dropColumn('notes')
    .dropColumn('live_cursor')
    .dropColumn('items_revision')
    .dropColumn('items')
    .dropColumn('speakers')
    .dropColumn('mode')
    .execute();
}
