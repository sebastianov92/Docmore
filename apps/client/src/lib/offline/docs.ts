import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { kvGet, kvSet } from "./idb.ts";

// Page bodies on the device. Each page is a Yjs document kept by y-indexeddb
// in its own database, page.<id> (the editor uses the same one). This module
// is how the sync engine touches those documents while no editor has them
// open: to fill them when a page is downloaded and to send what was written
// offline.

const SERVER_SYNCED_KEY = "serverSynced";
// what the server is known to have: the next push only sends what is newer
const SERVER_VECTOR_KEY = "serverVector";
const DIRTY_KEY = "docs.dirty";

export function pageDatabaseName(pageId: string): string {
  return `page.${pageId}`;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- which documents are open in an editor right now -----------------------

const openDocs = new Map<string, number>();

export function registerOpenDoc(pageId: string): () => void {
  openDocs.set(pageId, (openDocs.get(pageId) ?? 0) + 1);
  return () => {
    const count = (openDocs.get(pageId) ?? 1) - 1;
    if (count <= 0) openDocs.delete(pageId);
    else openDocs.set(pageId, count);
  };
}

export function isDocOpen(pageId: string): boolean {
  return openDocs.has(pageId);
}

// ---- documents with edits the server has not seen --------------------------

let dirty: Set<string> | null = null;
let dirtyWrite: ReturnType<typeof setTimeout> | null = null;
const dirtyListeners = new Set<() => void>();

async function loadDirty(): Promise<Set<string>> {
  if (!dirty) {
    try {
      dirty = new Set((await kvGet<string[]>(DIRTY_KEY)) ?? []);
    } catch {
      dirty = new Set();
    }
  }
  return dirty;
}

function persistDirty() {
  if (dirtyWrite) return;
  dirtyWrite = setTimeout(() => {
    dirtyWrite = null;
    if (dirty) void kvSet(DIRTY_KEY, [...dirty]).catch(() => {});
  }, 300);
}

export function subscribeDirtyDocs(listener: () => void): () => void {
  dirtyListeners.add(listener);
  return () => dirtyListeners.delete(listener);
}

export function markDocDirty(pageId: string): void {
  if (dirty?.has(pageId)) return;
  void loadDirty().then((set) => {
    if (set.has(pageId)) return;
    set.add(pageId);
    persistDirty();
    for (const listener of [...dirtyListeners]) listener();
  });
}

export function clearDocDirty(pageId: string): void {
  void loadDirty().then((set) => {
    if (!set.delete(pageId)) return;
    persistDirty();
    for (const listener of [...dirtyListeners]) listener();
  });
}

export async function getDirtyDocs(): Promise<string[]> {
  return [...(await loadDirty())];
}

export function dirtyDocCountSync(): number {
  return dirty?.size ?? 0;
}

export function resetDirtyDocs(): void {
  dirty = null;
}

// ---- reading and writing a document that is not open -----------------------

async function withLocalDoc<T>(
  pageId: string,
  fn: (doc: Y.Doc, local: IndexeddbPersistence) => Promise<T> | T,
): Promise<T> {
  const doc = new Y.Doc();
  const local = new IndexeddbPersistence(pageDatabaseName(pageId), doc);
  try {
    await local.whenSynced;
    return await fn(doc, local);
  } finally {
    await local.destroy().catch(() => {});
    doc.destroy();
  }
}

// A page created on this device: its (empty) local copy is the real page.
export async function markLocalPageDoc(pageId: string): Promise<void> {
  await withLocalDoc(pageId, async (_doc, local) => {
    await local.set(SERVER_SYNCED_KEY, Date.now());
  });
}

// What the engine sends for a page: its state vector, and the edits the
// server has not seen (null when there are none).
export async function localDocState(
  pageId: string,
): Promise<{ stateVector: string; update: string | null; empty: boolean }> {
  return withLocalDoc(pageId, async (doc, local) => {
    const vector = Y.encodeStateVector(doc);
    const stored = (await local.get(SERVER_VECTOR_KEY)) as string | undefined;
    const known = typeof stored === "string" && stored ? fromBase64(stored) : undefined;
    const diff = Y.encodeStateAsUpdate(doc, known);
    return {
      stateVector: toBase64(vector),
      // two zero bytes: no structs, no deletions
      update: diff.length > 2 ? toBase64(diff) : null,
      empty: doc.getXmlFragment("default").length === 0,
    };
  });
}

// The server's answer for a page: apply what was missing, and remember that
// the server now has everything this copy has.
export async function applyServerDoc(pageId: string, update: string | null | undefined): Promise<void> {
  await withLocalDoc(pageId, async (doc, local) => {
    if (update) Y.applyUpdate(doc, fromBase64(update));
    await local.set(SERVER_SYNCED_KEY, Date.now());
    await local.set(SERVER_VECTOR_KEY, toBase64(Y.encodeStateVector(doc)));
  });
}

// The live room finished syncing a document that is open in an editor.
export async function rememberServerHas(doc: Y.Doc, local: IndexeddbPersistence | undefined): Promise<void> {
  try {
    await local?.set(SERVER_VECTOR_KEY, toBase64(Y.encodeStateVector(doc)));
  } catch {
    // only costs a slightly larger push later
  }
}

export async function hasLocalDoc(pageId: string): Promise<boolean> {
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    return databases.some((db) => db.name === pageDatabaseName(pageId));
  } catch {
    return false;
  }
}

export async function localDocText(pageId: string): Promise<string> {
  return withLocalDoc(pageId, (doc) => {
    const parts: string[] = [];
    const walk = (node: any) => {
      if (node instanceof Y.XmlText) {
        parts.push(node.toString().replace(/<[^>]+>/g, ""));
      } else if (typeof node?.toArray === "function") {
        for (const child of node.toArray()) walk(child);
      }
    };
    walk(doc.getXmlFragment("default"));
    return parts.join("\n");
  });
}

export function deleteLocalDoc(pageId: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(pageDatabaseName(pageId));
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
