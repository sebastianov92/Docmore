import { type Kysely, sql } from 'kysely';

// Suggestions written by the assistant: who made them (the chat, a scheduled
// agent, an outside tool over MCP) and, for an addition, the piece to add,
// so accepting it adds to the page as it is then instead of replacing it.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_suggestions')
    .addColumn('origin', 'varchar') // null = a person | chat | agent | mcp
    .addColumn('origin_label', 'varchar')
    .addColumn('operation', 'varchar', (col) => col.notNull().defaultTo(sql`'replace'`)) // replace | append | prepend
    .addColumn('fragment', 'jsonb')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('page_suggestions')
    .dropColumn('fragment')
    .dropColumn('operation')
    .dropColumn('origin_label')
    .dropColumn('origin')
    .execute();
}
