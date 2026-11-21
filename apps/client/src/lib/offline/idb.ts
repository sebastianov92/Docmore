// A small promise wrapper over IndexedDB for the offline engine. One database
// per browser profile; signing out deletes it.

export const OFFLINE_DB_NAME = "docmore-offline";
const DB_VERSION = 1;

export type StoreName =
  | "kv"
  | "responses"
  | "tree"
  | "pages"
  | "outbox"
  | "conflicts"
  | "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(OFFLINE_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("responses")) {
        const store = db.createObjectStore("responses", { keyPath: "key" });
        store.createIndex("route", "route");
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains("tree")) {
        const store = db.createObjectStore("tree", { keyPath: "id" });
        store.createIndex("spaceId", "spaceId");
      }
      if (!db.objectStoreNames.contains("pages")) {
        const store = db.createObjectStore("pages", { keyPath: "id" });
        store.createIndex("slugId", "slugId");
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("conflicts")) {
        db.createObjectStore("conflicts", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // another tab upgrading or deleting the database must not hang on us
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed to open"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked"));
  });
}

export function offlineDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = open().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await offlineDb();
  return done(db.transaction(store, "readonly").objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbGetAll<T>(
  store: StoreName,
  index?: string,
  query?: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await offlineDb();
  const objectStore = db.transaction(store, "readonly").objectStore(store);
  const source = index ? objectStore.index(index) : objectStore;
  return done(source.getAll(query)) as Promise<T[]>;
}

export async function idbPut(store: StoreName, value: unknown): Promise<IDBValidKey> {
  const db = await offlineDb();
  const tx = db.transaction(store, "readwrite");
  const key = await done(tx.objectStore(store).put(value));
  await finished(tx);
  return key;
}

export async function idbBulkPut(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await offlineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const value of values) objectStore.put(value);
  await finished(tx);
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await offlineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await finished(tx);
}

export async function idbBulkDelete(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await offlineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const key of keys) objectStore.delete(key);
  await finished(tx);
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await offlineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await finished(tx);
}

export async function idbCount(store: StoreName): Promise<number> {
  const db = await offlineDb();
  return done(db.transaction(store, "readonly").objectStore(store).count());
}

// Oldest keys of an index, for trimming.
export async function idbOldestKeys(
  store: StoreName,
  index: string,
  count: number,
): Promise<IDBValidKey[]> {
  const db = await offlineDb();
  const source = db.transaction(store, "readonly").objectStore(store).index(index);
  return new Promise((resolve, reject) => {
    const keys: IDBValidKey[] = [];
    const request = source.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || keys.length >= count) {
        resolve(keys);
        return;
      }
      keys.push(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteOfflineDb(): Promise<void> {
  try {
    const db = await dbPromise?.catch(() => null);
    db?.close();
  } catch {
    // already closed
  }
  dbPromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

// key/value helpers
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await idbGet<{ key: string; value: T }>("kv", key);
  return row?.value;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await idbPut("kv", { key, value });
}

export async function kvDelete(key: string): Promise<void> {
  await idbDelete("kv", key);
}
