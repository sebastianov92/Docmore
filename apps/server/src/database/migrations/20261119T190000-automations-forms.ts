import { type Kysely, sql } from 'kysely';

// Automations (when X happens, do Y) with their run log, and public forms
// that drop submissions into a base.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('base_automations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('page_id', 'uuid', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('trigger', 'jsonb', (col) => col.notNull())
    .addColumn('conditions', 'jsonb')
    .addColumn('actions', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('creator_id', 'uuid')
    .addColumn('run_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_run_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_base_automations_page_id').on('base_automations').column('page_id').execute();

  await db.schema
    .createTable('base_automation_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('automation_id', 'uuid', (col) => col.notNull().references('base_automations.id').onDelete('cascade'))
    .addColumn('row_id', 'uuid')
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('idx_base_automation_runs_automation_created')
    .on('base_automation_runs')
    .columns(['automation_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('base_forms')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('page_id', 'uuid', (col) => col.notNull().references('pages.id').onDelete('cascade'))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('token', 'varchar', (col) => col.notNull().unique())
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('fields', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('submit_label', 'varchar')
    .addColumn('thanks_text', 'text')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('creator_id', 'uuid')
    .addColumn('submissions', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_base_forms_page_id').on('base_forms').column('page_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('base_forms').execute();
  await db.schema.dropTable('base_automation_runs').execute();
  await db.schema.dropTable('base_automations').execute();
}
