import { type Kysely, sql } from 'kysely';

// Block 9 of the Notion parity work: MCP servers the chat may call, shared
// skills (reusable prompts), research reports, meeting transcriptions and
// the transcription model choice.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ai_mcp_servers')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('url', 'varchar', (col) => col.notNull())
    .addColumn('scope', 'varchar', (col) => col.notNull().defaultTo('workspace')) // workspace | personal
    .addColumn('creator_id', 'uuid')
    .addColumn('auth', 'text') // encrypted json {headerName, headerValue}
    .addColumn('allowed_tools', 'jsonb') // null = every tool
    .addColumn('require_confirmation', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('tool_cache', 'jsonb')
    .addColumn('tools_checked_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('idx_ai_mcp_servers_workspace').on('ai_mcp_servers').column('workspace_id').execute();

  // A tool call that waits for the person's yes. Resolved rows stay a while
  // so a late click gets a clear answer.
  await db.schema
    .createTable('ai_tool_approvals')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('chat_id', 'uuid', (col) => col.notNull())
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('server_id', 'uuid', (col) => col.notNull())
    .addColumn('tool_call_id', 'varchar', (col) => col.notNull())
    .addColumn('tool_name', 'varchar', (col) => col.notNull())
    .addColumn('args', 'jsonb')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending')) // pending | approved | denied | expired
    .addColumn('result', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('resolved_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('idx_ai_tool_approvals_chat').on('ai_tool_approvals').column('chat_id').execute();

  await db.schema
    .createTable('ai_skills')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('creator_id', 'uuid')
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('slug', 'varchar', (col) => col.notNull())
    .addColumn('description', 'varchar')
    .addColumn('instructions', 'text', (col) => col.notNull())
    .addColumn('scope', 'varchar', (col) => col.notNull().defaultTo('workspace')) // workspace | personal
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('use_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('idx_ai_skills_workspace').on('ai_skills').column('workspace_id').execute();

  await db.schema
    .createTable('ai_research_reports')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('chat_id', 'uuid')
    .addColumn('space_id', 'uuid')
    .addColumn('question', 'text', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued')) // queued | running | done | failed
    .addColumn('progress', 'jsonb')
    .addColumn('report', 'text')
    .addColumn('sources', 'jsonb')
    .addColumn('usage', 'jsonb')
    .addColumn('error', 'text')
    .addColumn('page_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_ai_research_reports_user').on('ai_research_reports').columns(['workspace_id', 'user_id']).execute();

  await db.schema
    .createTable('ai_meeting_notes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('page_id', 'uuid')
    .addColumn('space_id', 'uuid')
    .addColumn('attachment_id', 'uuid')
    .addColumn('file_name', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued')) // queued | transcribing | summarizing | done | failed
    .addColumn('language', 'varchar')
    .addColumn('duration_seconds', 'integer')
    .addColumn('transcript', 'text')
    .addColumn('segments', 'jsonb')
    .addColumn('summary', 'text')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_ai_meeting_notes_user').on('ai_meeting_notes').columns(['workspace_id', 'user_id']).execute();

  await db.schema.alterTable('ai_settings').addColumn('transcription', 'jsonb').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ai_settings').dropColumn('transcription').execute();
  await db.schema.dropTable('ai_meeting_notes').ifExists().execute();
  await db.schema.dropTable('ai_research_reports').ifExists().execute();
  await db.schema.dropTable('ai_skills').ifExists().execute();
  await db.schema.dropTable('ai_tool_approvals').ifExists().execute();
  await db.schema.dropTable('ai_mcp_servers').ifExists().execute();
}
