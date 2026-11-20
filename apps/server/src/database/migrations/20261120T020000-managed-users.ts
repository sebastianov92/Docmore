import { type Kysely } from 'kysely';

// Managed users: an account can be told to sign in only through SSO.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').addColumn('password_login_locked', 'boolean', (col) => col.notNull().defaultTo(false)).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('password_login_locked').execute();
}
