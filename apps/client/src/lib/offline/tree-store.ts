import { idbBulkDelete, idbBulkPut, idbGetAll, kvGet, kvSet } from "./idb.ts";

// The page tree of every space the person can see, kept whole on the device:
// one small row per page. With it the sidebar, breadcrumbs and links work
// with no server, including for pages whose body was never downloaded.

export type TreeRow = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  position: string;
  parentPageId: string | null;
  spaceId: string;
  creatorId: string | null;
  isBase: boolean;
  updatedAt: string;
  canEdit: boolean;
  // created on this device and not on the server yet
  localOnly?: boolean;
};

const SPACES_KEY = "tree.spaces";

let rows: Map<string, TreeRow> | null = null;
let bySlug = new Map<string, string>();
let loading: Promise<void> | null = null;
// spaces whose whole tree is on the device
let loadedSpaces = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

async function load(): Promise<void> {
  if (rows) return;
  if (!loading) {
    loading = (async () => {
      const all = await idbGetAll<TreeRow>("tree");
      const map = new Map<string, TreeRow>();
      bySlug = new Map();
      for (const row of all) {
        map.set(row.id, row);
        bySlug.set(row.slugId, row.id);
      }
      loadedSpaces = new Set((await kvGet<string[]>(SPACES_KEY)) ?? []);
      rows = map;
    })().finally(() => {
      loading = null;
    });
  }
  await loading;
}

function changed() {
  version++;
  for (const listener of [...listeners]) listener();
}

export function subscribeTree(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function treeVersion(): number {
  return version;
}

// position is a fractional index compared in byte order (the server sorts it
// with the C collation), ties broken by id
function byPosition(a: TreeRow, b: TreeRow): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function treeGet(idOrSlug: string): Promise<TreeRow | undefined> {
  await load();
  return rows!.get(idOrSlug) ?? rows!.get(bySlug.get(idOrSlug) ?? "");
}

// Synchronous read for render paths; undefined until the tree was loaded once.
export function treeGetSync(idOrSlug: string): TreeRow | undefined {
  if (!rows) return undefined;
  return rows.get(idOrSlug) ?? rows.get(bySlug.get(idOrSlug) ?? "");
}

export async function treeAll(): Promise<TreeRow[]> {
  await load();
  return [...rows!.values()];
}

export async function treeChildren(spaceId: string, parentPageId: string | null): Promise<TreeRow[]> {
  await load();
  const out: TreeRow[] = [];
  for (const row of rows!.values()) {
    if (row.spaceId === spaceId && (row.parentPageId ?? null) === parentPageId) out.push(row);
  }
  return out.sort(byPosition);
}

export async function treeHasChildren(id: string): Promise<boolean> {
  await load();
  for (const row of rows!.values()) if (row.parentPageId === id) return true;
  return false;
}

export async function treeChildCounts(): Promise<Set<string>> {
  await load();
  const parents = new Set<string>();
  for (const row of rows!.values()) if (row.parentPageId) parents.add(row.parentPageId);
  return parents;
}

// The page and everything under it.
export async function treeSubtree(id: string): Promise<TreeRow[]> {
  await load();
  const root = rows!.get(id);
  if (!root) return [];
  const childrenOf = new Map<string, TreeRow[]>();
  for (const row of rows!.values()) {
    if (!row.parentPageId) continue;
    const list = childrenOf.get(row.parentPageId) ?? [];
    list.push(row);
    childrenOf.set(row.parentPageId, list);
  }
  const out: TreeRow[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    for (const child of childrenOf.get(row.id) ?? []) stack.push(child);
  }
  return out;
}

// From the root down to the page itself.
export async function treeAncestors(id: string): Promise<TreeRow[]> {
  await load();
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  let current = rows!.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current);
    current = current.parentPageId ? rows!.get(current.parentPageId) : undefined;
  }
  return out;
}

export async function treeSpaceRows(spaceId: string): Promise<TreeRow[]> {
  await load();
  return [...rows!.values()].filter((row) => row.spaceId === spaceId);
}

export async function treeLastPosition(spaceId: string, parentPageId: string | null): Promise<string | null> {
  const children = await treeChildren(spaceId, parentPageId);
  return children.length ? children[children.length - 1].position : null;
}

export async function treeUpsert(items: TreeRow | TreeRow[]): Promise<void> {
  await load();
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return;
  for (const row of list) {
    const previous = rows!.get(row.id);
    if (previous && previous.slugId !== row.slugId) bySlug.delete(previous.slugId);
    rows!.set(row.id, row);
    bySlug.set(row.slugId, row.id);
  }
  await idbBulkPut("tree", list);
  changed();
}

export async function treePatch(id: string, patch: Partial<TreeRow>): Promise<TreeRow | undefined> {
  await load();
  const current = rows!.get(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  await treeUpsert(next);
  return next;
}

export async function treeRemove(ids: string[]): Promise<void> {
  await load();
  const present = ids.filter((id) => rows!.has(id));
  if (present.length === 0) return;
  for (const id of present) {
    bySlug.delete(rows!.get(id)!.slugId);
    rows!.delete(id);
  }
  await idbBulkDelete("tree", present);
  changed();
}

// Replaces what the device knows of one space with a fresh full listing.
// Rows that only exist here (created offline, not sent yet) are kept.
export async function treeReplaceSpace(spaceId: string, fresh: TreeRow[]): Promise<void> {
  await load();
  const freshIds = new Set(fresh.map((row) => row.id));
  const stale: string[] = [];
  for (const row of rows!.values()) {
    if (row.spaceId === spaceId && !freshIds.has(row.id) && !row.localOnly) stale.push(row.id);
  }
  await treeRemove(stale);
  await treeUpsert(fresh);
  if (!loadedSpaces.has(spaceId)) {
    loadedSpaces.add(spaceId);
    await kvSet(SPACES_KEY, [...loadedSpaces]);
  }
}

export async function treeDropSpace(spaceId: string): Promise<void> {
  await load();
  await treeRemove((await treeSpaceRows(spaceId)).map((row) => row.id));
  if (loadedSpaces.delete(spaceId)) await kvSet(SPACES_KEY, [...loadedSpaces]);
}

export async function treeHasSpace(spaceId: string): Promise<boolean> {
  await load();
  return loadedSpaces.has(spaceId);
}

export async function treeLoadedSpaces(): Promise<string[]> {
  await load();
  return [...loadedSpaces];
}

// Forget everything in memory (the database was deleted).
export function treeReset(): void {
  rows = null;
  bySlug = new Map();
  loadedSpaces = new Set();
  changed();
}
