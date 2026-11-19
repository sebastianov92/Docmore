import { type Kysely } from 'kysely';

// A share link can ask for a password and can stop working after a date.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('shares')
    .addColumn('password_hash', 'varchar')
    .execute();
  await db.schema
    .alterTable('shares')
    .addColumn('expires_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('shares').dropColumn('expires_at').execute();
  await db.schema.alterTable('shares').dropColumn('password_hash').execute();
}
