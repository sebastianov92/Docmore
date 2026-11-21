import { type Kysely, sql } from 'kysely';

// Offline sync.
//
// sync_changes keeps ONE row per entity, with a sequence number that moves
// forward on every change. A device asks "what changed after N" and gets a
// list bounded by the number of entities, not by the number of edits (a page
// body is stored every few seconds while someone types). Deletions stay as
// tombstones. Triggers feed it so no code path can forget to.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE SEQUENCE IF NOT EXISTS sync_changes_seq`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS sync_changes (
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      deleted boolean NOT NULL DEFAULT false,
      changed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (entity_type, entity_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_sync_changes_workspace_seq ON sync_changes (workspace_id, seq)`.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION sync_touch(p_type text, p_id uuid, p_workspace uuid, p_deleted boolean)
    RETURNS void AS $$
    BEGIN
      IF p_id IS NULL OR p_workspace IS NULL THEN
        RETURN;
      END IF;
      INSERT INTO sync_changes (entity_type, entity_id, workspace_id, seq, deleted, changed_at)
      VALUES (p_type, p_id, p_workspace, nextval('sync_changes_seq'), p_deleted, clock_timestamp())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET seq = nextval('sync_changes_seq'),
            deleted = EXCLUDED.deleted,
            workspace_id = EXCLUDED.workspace_id,
            changed_at = clock_timestamp();
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  // pages: the tree entry and the body are separate entities, a keystroke
  // must not make every device refetch the tree.
  await sql`
    CREATE OR REPLACE FUNCTION sync_pages_trg() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM sync_touch('page', OLD.id, OLD.workspace_id, true);
        RETURN OLD;
      END IF;
      IF TG_OP = 'INSERT' THEN
        PERFORM sync_touch('page', NEW.id, NEW.workspace_id, NEW.deleted_at IS NOT NULL);
        IF NEW.ydoc IS NOT NULL THEN
          PERFORM sync_touch('page_body', NEW.id, NEW.workspace_id, false);
        END IF;
        RETURN NEW;
      END IF;
      IF (NEW.title, NEW.icon, NEW.parent_page_id, NEW.position, NEW.space_id, NEW.slug_id, NEW.deleted_at, NEW.is_locked, NEW.is_base, NEW.base_locked, NEW.cover_photo, NEW.cover_position, NEW.owner_id)
         IS DISTINCT FROM
         (OLD.title, OLD.icon, OLD.parent_page_id, OLD.position, OLD.space_id, OLD.slug_id, OLD.deleted_at, OLD.is_locked, OLD.is_base, OLD.base_locked, OLD.cover_photo, OLD.cover_position, OLD.owner_id) THEN
        PERFORM sync_touch('page', NEW.id, NEW.workspace_id, NEW.deleted_at IS NOT NULL);
      END IF;
      IF NEW.ydoc IS DISTINCT FROM OLD.ydoc THEN
        PERFORM sync_touch('page_body', NEW.id, NEW.workspace_id, false);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_pages ON pages`.execute(db);
  await sql`CREATE TRIGGER sync_pages AFTER INSERT OR UPDATE OR DELETE ON pages FOR EACH ROW EXECUTE FUNCTION sync_pages_trg()`.execute(db);

  // comments and base data are tracked per page: "the comments of page X changed".
  await sql`
    CREATE OR REPLACE FUNCTION sync_page_child_trg() RETURNS trigger AS $$
    DECLARE
      r record;
    BEGIN
      IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
      PERFORM sync_touch(TG_ARGV[0], r.page_id, r.workspace_id, false);
      RETURN r;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  for (const [table, type] of [
    ['comments', 'page_comments'],
    ['base_rows', 'base_data'],
    ['base_properties', 'base_data'],
    ['base_views', 'base_data'],
  ]) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(`sync_${table}`)} ON ${sql.raw(table)}`.execute(db);
    await sql`
      CREATE TRIGGER ${sql.raw(`sync_${table}`)} AFTER INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
      FOR EACH ROW EXECUTE FUNCTION sync_page_child_trg(${sql.lit(type)})
    `.execute(db);
  }

  await sql`
    CREATE OR REPLACE FUNCTION sync_spaces_trg() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        PERFORM sync_touch('space', OLD.id, OLD.workspace_id, true);
        RETURN OLD;
      END IF;
      PERFORM sync_touch('space', NEW.id, NEW.workspace_id, NEW.deleted_at IS NOT NULL);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_spaces ON spaces`.execute(db);
  await sql`CREATE TRIGGER sync_spaces AFTER INSERT OR UPDATE OR DELETE ON spaces FOR EACH ROW EXECUTE FUNCTION sync_spaces_trg()`.execute(db);

  // Who can see what changed somewhere in the workspace: one coarse marker,
  // devices answer it by reloading their page tree.
  await sql`
    CREATE OR REPLACE FUNCTION sync_access_trg() RETURNS trigger AS $$
    DECLARE
      r record;
      ws uuid;
    BEGIN
      IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
      IF TG_TABLE_NAME = 'space_members' THEN
        SELECT workspace_id INTO ws FROM spaces WHERE id = r.space_id;
      ELSIF TG_TABLE_NAME = 'group_users' THEN
        SELECT workspace_id INTO ws FROM groups WHERE id = r.group_id;
      ELSIF TG_TABLE_NAME = 'page_permissions' THEN
        SELECT workspace_id INTO ws FROM page_access WHERE id = r.page_access_id;
      ELSE
        ws := r.workspace_id;
      END IF;
      PERFORM sync_touch('access', ws, ws, false);
      RETURN r;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  for (const table of ['space_members', 'group_users', 'page_access', 'page_permissions']) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(`sync_${table}`)} ON ${sql.raw(table)}`.execute(db);
    await sql`
      CREATE TRIGGER ${sql.raw(`sync_${table}`)} AFTER INSERT OR UPDATE OR DELETE ON ${sql.raw(table)}
      FOR EACH ROW EXECUTE FUNCTION sync_access_trg()
    `.execute(db);
  }

  await sql`
    CREATE OR REPLACE FUNCTION sync_users_trg() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        PERFORM sync_touch('members', NEW.workspace_id, NEW.workspace_id, false);
        RETURN NEW;
      END IF;
      IF (NEW.name, NEW.avatar_url, NEW.role, NEW.deactivated_at, NEW.deleted_at)
         IS DISTINCT FROM (OLD.name, OLD.avatar_url, OLD.role, OLD.deactivated_at, OLD.deleted_at) THEN
        PERFORM sync_touch('members', NEW.workspace_id, NEW.workspace_id, false);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_users ON users`.execute(db);
  await sql`CREATE TRIGGER sync_users AFTER INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sync_users_trg()`.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION sync_workspaces_trg() RETURNS trigger AS $$
    BEGIN
      IF (NEW.name, NEW.logo, NEW.settings, NEW.default_role)
         IS DISTINCT FROM (OLD.name, OLD.logo, OLD.settings, OLD.default_role) THEN
        PERFORM sync_touch('workspace', NEW.id, NEW.id, false);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_workspaces ON workspaces`.execute(db);
  await sql`CREATE TRIGGER sync_workspaces AFTER UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION sync_workspaces_trg()`.execute(db);

  // A queued offline change can be sent twice (the answer got lost): the key
  // makes the second attempt return the first answer instead of running again.
  await db.schema
    .createTable('idempotency_keys')
    .ifNotExists()
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('key', 'varchar(100)', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('route', 'varchar(200)', (col) => col.notNull())
    .addColumn('response', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('idempotency_keys_pkey', ['user_id', 'key'])
    .execute();
  await sql`CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys (created_at)`.execute(db);

  // What a person marked "available offline", per device, so a reinstall
  // brings the selection back.
  await db.schema
    .createTable('offline_pins')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('workspace_id', 'uuid', (col) => col.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('device_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('device_name', 'varchar(120)')
    .addColumn('entity_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('entity_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_pins_unique
      ON offline_pins (user_id, device_id, entity_type, entity_id)
  `.execute(db);

  // Devices start from a snapshot, but a tombstone for everything that was
  // already in the trash keeps "deleted" answers honest from the first pull.
  await sql`
    INSERT INTO sync_changes (entity_type, entity_id, workspace_id, seq, deleted)
    SELECT 'page', id, workspace_id, nextval('sync_changes_seq'), true
    FROM pages WHERE deleted_at IS NOT NULL
    ON CONFLICT DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of [
    'pages', 'comments', 'base_rows', 'base_properties', 'base_views', 'spaces',
    'space_members', 'group_users', 'page_access', 'page_permissions', 'users', 'workspaces',
  ]) {
    await sql`DROP TRIGGER IF EXISTS ${sql.raw(`sync_${table}`)} ON ${sql.raw(table)}`.execute(db);
  }
  for (const fn of [
    'sync_pages_trg', 'sync_page_child_trg', 'sync_spaces_trg', 'sync_access_trg', 'sync_users_trg', 'sync_workspaces_trg',
  ]) {
    await sql`DROP FUNCTION IF EXISTS ${sql.raw(fn)}()`.execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS sync_touch(text, uuid, uuid, boolean)`.execute(db);
  await db.schema.dropTable('offline_pins').ifExists().execute();
  await db.schema.dropTable('idempotency_keys').ifExists().execute();
  await db.schema.dropTable('sync_changes').ifExists().execute();
  await sql`DROP SEQUENCE IF EXISTS sync_changes_seq`.execute(db);
}
