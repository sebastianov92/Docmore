import { type Kysely, sql } from 'kysely';

// Outgoing webhooks: where domain events are posted, and what happened to
// each delivery.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('name', 'varchar', (col) => col.notNull())
    .addColumn('url', 'varchar', (col) => col.notNull())
    .addColumn('secret', 'text', (col) => col.notNull())
    .addColumn('events', 'jsonb', (col) => col.notNull().defaultTo(sql`'["*"]'::jsonb`))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('failures', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_delivered_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('creator_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_webhooks_workspace').on('webhooks').column('workspace_id').execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('webhook_id', 'uuid', (col) => col.notNull().references('webhooks.id').onDelete('cascade'))
    .addColumn('event', 'varchar', (col) => col.notNull())
    .addColumn('status', 'integer')
    .addColumn('ok', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('error', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('attempt', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_webhook_deliveries_webhook_created').on('webhook_deliveries').columns(['webhook_id', 'created_at']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('webhook_deliveries').execute();
  await db.schema.dropTable('webhooks').execute();
}
