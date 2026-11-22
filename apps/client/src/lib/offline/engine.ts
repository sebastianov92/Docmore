import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { nativeSend } from "@/lib/native/bridge.ts";
import {
  noteTextChanged,
  resetSystemSearch,
  scheduleSystemSearch,
  startSystemSearch,
  stopSystemSearch,
} from "./system-search.ts";
import { disableOfflineAnswers, enableOfflineAnswers } from "./adapter.ts";
import {
  getConnectivity,
  isOnline,
  onBackOnline,
  subscribeConnectivity,
} from "./connectivity.ts";
import {
  applyServerDoc,
  clearDocDirty,
  deleteLocalDoc,
  dirtyDocCountSync,
  getDirtyDocs,
  isDocOpen,
  localDocState,
  resetDirtyDocs,
  subscribeDirtyDocs,
} from "./docs.ts";
import { clearFiles, ensureFiles, fileUrlsInContent, requestUrlForFile } from "./files.ts";
import { MUTATIONS, forgetPageLocally, rowFromPage } from "./handlers.ts";
import { deleteOfflineDb, kvGet, kvSet } from "./idb.ts";
import {
  addConflict,
  listOutbox,
  outboxCounts,
  refreshOutboxCounts,
  removeOp,
  resetOutboxCounts,
  subscribeOutbox,
  updateOp,
} from "./outbox.ts";
import {
  deviceName,
  getDeviceId,
  getOfflineSettings,
  getPins,
  isPageDownloaded,
  isPageWanted,
  loadPins,
  markDownloaded,
  recomputeWanted,
  replacePins,
  resetPins,
  setPinned,
  unmarkDownloaded,
  wantedPages,
  downloadedPages,
} from "./pins.ts";
import { ServerError, isNoAnswer, rawPost } from "./raw-api.ts";
import { sendQueuedUpload } from "./uploads.ts";
import { ensureShellCached } from "./service-worker.ts";
import {
  Me,
  getPageInfo,
  recordResponse,
  recordedFor,
  removePageInfo,
  saveMe,
  savePageInfo,
  saveSpaces,
} from "./recorder.ts";
import {
  TreeRow,
  treeDropSpace,
  treeGet,
  treeLoadedSpaces,
  treeRemove,
  treeReplaceSpace,
  treeReset,
  treeUpsert,
} from "./tree-store.ts";

// The sync engine. Whenever the server answers it: sends what was queued
// offline, sends page bodies edited offline, takes what changed on the
// server since the last time, and brings down what the person asked to keep.

export type OfflineStatus = {
  // local stores are usable on this device
  ready: boolean;
  syncing: boolean;
  // queued writes plus page bodies waiting to go up
  pending: number;
  conflicts: number;
  download: { done: number; total: number } | null;
  lastSyncAt: number | null;
  lastError: string | null;
};

const OWNER_KEY = "owner";
const CURSOR_KEY = "sync.cursor";
const LAST_SYNC_KEY = "sync.last";
const PINS_PUSHED_KEY = "pins.pushed";
const PULL_INTERVAL_MS = 45_000;
const DOC_BATCH = 10;
const MAX_ATTEMPTS = 5;
// a JSON body near the server's 8 MB limit is sent alone, a larger one waits
// for the page to be opened (the live room has no such limit)
const MAX_UPDATE_BASE64 = 6_500_000;

let status: OfflineStatus = {
  ready: false,
  syncing: false,
  pending: 0,
  conflicts: 0,
  download: null,
  lastSyncAt: null,
  lastError: null,
};
const listeners = new Set<() => void>();
let queryClient: QueryClient | null = null;
let started = false;
let running: Promise<void> | null = null;
let again = false;
let interval: ReturnType<typeof setInterval> | null = null;
let unsubscribers: Array<() => void> = [];
// pages whose body / comments changed on the server since they were brought down
const staleBodies = new Set<string>();
const staleComments = new Set<string>();

function setStatus(patch: Partial<OfflineStatus>) {
  status = { ...status, ...patch };
  for (const listener of [...listeners]) listener();
  nativeSend("state", {
    online: getConnectivity().online,
    pending: status.pending,
    syncing: status.syncing,
    conflicts: status.conflicts,
  });
}

function refreshCounts() {
  const counts = outboxCounts();
  setStatus({ pending: counts.pending + dirtyDocCountSync(), conflicts: counts.conflicts });
}

export function getOfflineStatus(): OfflineStatus {
  return status;
}

export function subscribeOfflineStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(subscribeOfflineStatus, getOfflineStatus, getOfflineStatus);
}

// ---- start and stop ----------------------------------------------------------

// As early as possible at app start: if this device already holds someone's
// data, requests can be answered from it before anything else loads.
export async function bootOfflineAnswers(): Promise<void> {
  try {
    const owner = await kvGet<string>(OWNER_KEY);
    if (!owner) return;
    await loadPins();
    await refreshOutboxCounts();
    await getDirtyDocs();
    enableOfflineAnswers({ onQueued: refreshCounts });
    setStatus({ ready: true, lastSyncAt: (await kvGet<number>(LAST_SYNC_KEY)) ?? null });
    refreshCounts();
  } catch {
    // no IndexedDB: the app works as before, online only
  }
}

// Once the app knows who is signed in.
export async function startOfflineEngine(client: QueryClient, me: Me): Promise<void> {
  queryClient = client;
  if (!me?.user?.id) return;
  try {
    const owner = await kvGet<string>(OWNER_KEY);
    if (owner && owner !== me.user.id) {
      // someone else's data is on this device
      await wipeOfflineData();
    }
    await kvSet(OWNER_KEY, me.user.id);
    await saveMe(me);
    await loadPins();
    await refreshOutboxCounts();
    await getDirtyDocs();
    enableOfflineAnswers({ onQueued: refreshCounts });
    setStatus({ ready: true, lastSyncAt: (await kvGet<number>(LAST_SYNC_KEY)) ?? null });
    refreshCounts();
  } catch {
    setStatus({ ready: false });
    return;
  }
  startSystemSearch();
  if (started) return;
  started = true;
  unsubscribers = [
    subscribeOutbox(refreshCounts),
    subscribeDirtyDocs(refreshCounts),
    subscribeConnectivity(() => setStatus({})),
    onBackOnline(() => {
      // screens that failed for lack of a server load now
      void queryClient?.refetchQueries({ predicate: (query) => query.state.status === "error" });
      void syncNow();
    }),
  ];
  interval = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (isOnline()) void syncNow();
    else void refreshOutboxCounts().catch(() => {});
  }, PULL_INTERVAL_MS);
  if (isOnline()) void syncNow();
}

// Signing out, or another person signing in: nothing of the previous one stays.
export async function wipeOfflineData(): Promise<void> {
  started = false;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  if (interval) clearInterval(interval);
  interval = null;
  stopSystemSearch();
  disableOfflineAnswers();
  const pages = downloadedPages();
  try {
    await deleteOfflineDb();
  } catch {
    // nothing to delete
  }
  await Promise.all(pages.map((id) => deleteLocalDoc(id).catch(() => {})));
  await clearFiles().catch(() => {});
  await resetSystemSearch();
  treeReset();
  resetPins();
  resetOutboxCounts();
  resetDirtyDocs();
  staleBodies.clear();
  staleComments.clear();
  setStatus({ ready: false, syncing: false, pending: 0, conflicts: 0, download: null, lastSyncAt: null, lastError: null });
}

// ---- the loop ----------------------------------------------------------------

// Runs a full sync. Calls made while one is running are folded into one more
// run right after it.
export function syncNow(): Promise<void> {
  if (!status.ready || !isOnline()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await withSyncLock(runOnce);
    } while (again && isOnline());
  })().finally(() => {
    running = null;
  });
  return running;
}

// One tab at a time talks to the server on behalf of the shared local data.
async function withSyncLock(fn: () => Promise<void>): Promise<void> {
  const locks = (navigator as any).locks;
  if (!locks?.request) {
    await fn();
    return;
  }
  await locks.request("docmore-offline-sync", { ifAvailable: true }, async (lock: unknown) => {
    if (lock) await fn();
  });
}

async function runOnce(): Promise<void> {
  // another tab may have queued or sent things since
  await refreshOutboxCounts().catch(() => {});
  setStatus({ syncing: true, lastError: null });
  let changedOnServer = false;
  try {
    const flushed = await flushOutbox();
    const pushed = await pushDirtyDocs();
    changedOnServer = flushed > 0 || pushed > 0;
    await pull();
    await pushPins();
    await download();
    void ensureShellCached();
    const now = Date.now();
    await kvSet(LAST_SYNC_KEY, now);
    setStatus({ lastSyncAt: now });
  } catch (error) {
    if (!isNoAnswer(error)) {
      setStatus({ lastError: (error as Error)?.message ?? "Sync failed" });
    }
  } finally {
    setStatus({ syncing: false, download: null });
    refreshCounts();
    if (changedOnServer) {
      // what the screens show was built from local answers
      void queryClient?.invalidateQueries();
    }
  }
}

// ---- queued writes -----------------------------------------------------------

async function flushOutbox(): Promise<number> {
  let flushed = 0;
  for (const op of await listOutbox()) {
    try {
      const data =
        op.route === "/files/upload"
          ? await sendQueuedUpload(op)
          : await rawPost<any>(op.route, op.body, { headers: { "Idempotency-Key": op.id } });
      try {
        await MUTATIONS[op.route]?.apply({ body: op.body, server: data ?? {} });
      } catch {
        // the server has it; the next pull straightens the local copy
      }
      await removeOp(op);
      flushed++;
    } catch (error) {
      if (!(error instanceof ServerError)) throw error;
      if (error.status === 401) throw error;
      if (error.status >= 500 || error.status === 429) {
        op.attempts += 1;
        op.lastError = error.message;
        if (op.attempts < MAX_ATTEMPTS) {
          await updateOp(op);
          // later ones may depend on this one
          return flushed;
        }
      }
      // refused: it leaves the queue and waits for the person
      await addConflict({
        type: "op",
        kind: op.kind,
        route: op.route,
        body: op.body,
        pageId: op.pageId,
        title: op.title,
        reason: error.message,
        status: error.status,
      });
      await removeOp(op);
    }
  }
  return flushed;
}

// ---- page bodies -------------------------------------------------------------

type DocResult = { pageId: string; status: string; update?: string };

async function syncDocs(docs: Array<{ pageId: string; stateVector?: string; update?: string | null }>): Promise<DocResult[]> {
  const payload = docs.map((doc) => ({
    pageId: doc.pageId,
    ...(doc.stateVector ? { stateVector: doc.stateVector } : {}),
    ...(doc.update ? { update: doc.update } : {}),
  }));
  const result = await rawPost<{ docs: DocResult[] }>("/sync/docs", { docs: payload });
  return result?.docs ?? [];
}

async function pushDirtyDocs(): Promise<number> {
  const ids = (await getDirtyDocs()).filter((id) => !isDocOpen(id));
  if (ids.length === 0) return 0;
  let pushed = 0;
  let batch: Array<{ pageId: string; stateVector: string; update: string }> = [];
  let batchSize = 0;

  const send = async () => {
    if (batch.length === 0) return;
    const sent = batch;
    batch = [];
    batchSize = 0;
    for (const result of await syncDocs(sent)) {
      const row = await treeGet(result.pageId);
      const title = row?.title ?? (await getPageInfo(result.pageId))?.title ?? undefined;
      if (result.status === "ok") {
        await applyServerDoc(result.pageId, result.update);
        clearDocDirty(result.pageId);
        staleBodies.add(result.pageId);
        pushed++;
        continue;
      }
      // the edits stay on the device; the person decides
      clearDocDirty(result.pageId);
      await addConflict({
        id: `doc:${result.pageId}`,
        type: "doc",
        kind: `doc.${result.status}`,
        pageId: result.pageId,
        title,
        reason: result.status,
      });
    }
  };

  for (const id of ids) {
    let state: Awaited<ReturnType<typeof localDocState>>;
    try {
      state = await localDocState(id);
    } catch {
      continue;
    }
    if (!state.update) {
      clearDocDirty(id);
      continue;
    }
    if (state.update.length > MAX_UPDATE_BASE64) {
      clearDocDirty(id);
      await addConflict({
        id: `doc:${id}`,
        type: "doc",
        kind: "doc.too_large",
        pageId: id,
        title: (await treeGet(id))?.title ?? undefined,
        reason: "too_large",
      });
      continue;
    }
    if (batch.length >= DOC_BATCH || batchSize + state.update.length > MAX_UPDATE_BASE64) await send();
    batch.push({ pageId: id, stateVector: state.stateVector, update: state.update });
    batchSize += state.update.length;
  }
  await send();
  return pushed;
}

// Brings the bodies of these pages down (or up to date).
async function pullDocs(pageIds: string[]): Promise<Set<string>> {
  const done = new Set<string>();
  const ids = pageIds.filter((id) => !isDocOpen(id));
  for (let i = 0; i < ids.length; i += DOC_BATCH * 2) {
    const chunk = ids.slice(i, i + DOC_BATCH * 2);
    const states = await Promise.all(
      chunk.map(async (pageId) => {
        try {
          return { pageId, stateVector: (await localDocState(pageId)).stateVector };
        } catch {
          return { pageId };
        }
      }),
    );
    for (const result of await syncDocs(states)) {
      if (result.status === "ok" || result.status === "read_only") {
        await applyServerDoc(result.pageId, result.update);
        done.add(result.pageId);
      }
    }
  }
  return done;
}

// ---- what changed on the server ----------------------------------------------

async function snapshot(): Promise<void> {
  const snap = await rawPost<{ cursor: string; spaces: Array<{ id: string; canEdit: boolean }> }>("/sync/snapshot");
  const spaceIds = new Set(snap.spaces.map((space) => space.id));
  for (const space of snap.spaces) {
    const rows: TreeRow[] = [];
    let after: string | null = null;
    do {
      const chunk: { items: any[]; next: string | null } = await rawPost("/sync/space-pages", {
        spaceId: space.id,
        ...(after ? { after } : {}),
      });
      for (const item of chunk.items) rows.push(rowFromPage(item));
      after = chunk.next;
    } while (after);
    await treeReplaceSpace(space.id, rows);
  }
  for (const known of await treeLoadedSpaces()) {
    if (!spaceIds.has(known)) await treeDropSpace(known);
  }
  try {
    const spaces = await rawPost<{ items: any[] }>("/spaces", { limit: 100 });
    if (Array.isArray(spaces?.items)) await saveSpaces(spaces.items);
  } catch (error) {
    if (isNoAnswer(error)) throw error;
  }
  // each space in full (role, settings): pages ask for it by slug or by id
  for (const space of snap.spaces) {
    try {
      const info = await rawPost<any>("/spaces/info", { spaceId: space.id });
      if (!info?.id) continue;
      await saveSpaces([info]);
      await recordResponse("/spaces/info", { spaceId: info.id }, info);
      if (info.slug) await recordResponse("/spaces/info", { spaceId: info.slug }, info);
    } catch (error) {
      if (isNoAnswer(error)) throw error;
    }
  }
  await kvSet(CURSOR_KEY, snap.cursor);
  await recomputeWanted();
  await dropUnreachable();
}

// Pages that are no longer in the tree (access lost, space gone) leave the
// device, unless they hold edits that were never sent.
async function dropUnreachable(): Promise<void> {
  const dirty = new Set(await getDirtyDocs());
  const gone: string[] = [];
  for (const id of downloadedPages()) {
    if (isPageWanted(id) && (await treeGet(id))) continue;
    if (await treeGet(id)) continue;
    if (dirty.has(id)) continue;
    gone.push(id);
  }
  if (gone.length === 0) return;
  unmarkDownloaded(gone);
  await removePageInfo(gone);
  for (const id of gone) {
    await forgetPageLocally(id);
    await deleteLocalDoc(id);
  }
}

async function refreshRecorded(route: string, after?: (data: any) => Promise<void>): Promise<void> {
  for (const record of await recordedFor(route)) {
    try {
      const data = await rawPost<any>(route, record.body);
      await recordResponse(route, record.body, data);
      if (after) await after(data);
    } catch (error) {
      if (isNoAnswer(error)) throw error;
    }
  }
}

async function pull(): Promise<void> {
  let cursor = await kvGet<string>(CURSOR_KEY);
  if (!cursor) {
    await snapshot();
    return;
  }
  let needSnapshot = false;
  let more = true;
  let rounds = 0;
  while (more && rounds < 40) {
    rounds++;
    const result: { cursor: string; more: boolean; changes: any[] } = await rawPost("/sync/pull", { cursor });
    const dirty = new Set(await getDirtyDocs());
    for (const change of result.changes ?? []) {
      switch (change.type) {
        case "page": {
          if (change.deleted) {
            const row = await treeGet(change.id);
            if (!row || row.localOnly) break;
            if (dirty.has(change.id)) {
              // edited here, gone there: the person decides
              await addConflict({
                id: `doc:${change.id}`,
                type: "doc",
                kind: "doc.deleted",
                pageId: change.id,
                title: row.title ?? undefined,
                reason: "deleted",
              });
            }
            await treeRemove([change.id]);
            break;
          }
          if (change.page?.id) {
            await treeUpsert(rowFromPage(change.page));
          }
          break;
        }
        case "page_body":
          if (isPageWanted(change.id) || isPageDownloaded(change.id)) staleBodies.add(change.id);
          break;
        case "page_comments":
          if (isPageWanted(change.id) || isPageDownloaded(change.id)) staleComments.add(change.id);
          break;
        case "base_data":
          if (isPageWanted(change.id) && isPageDownloaded(change.id)) staleBodies.add(change.id);
          break;
        case "space":
          needSnapshot = true;
          break;
        case "access":
          needSnapshot = true;
          break;
        case "members":
          await refreshRecorded("/workspace/members");
          break;
        case "workspace":
          await refreshRecorded("/users/me", async (data) => {
            if (data?.user?.id) await saveMe(data);
          });
          break;
        default:
          break;
      }
    }
    cursor = result.cursor;
    await kvSet(CURSOR_KEY, cursor);
    more = Boolean(result.more);
  }
  if (needSnapshot) await snapshot();
}

// ---- the selection, mirrored on the server ------------------------------------

async function pushPins(): Promise<void> {
  const pins = getPins();
  const signature = JSON.stringify(pins);
  const pushed = await kvGet<string>(PINS_PUSHED_KEY);
  try {
    const deviceId = await getDeviceId();
    if (pushed === undefined) {
      // first sync of this device: a previous install may have left a selection
      const remote = await rawPost<{ pins: Array<{ type: "space" | "page"; id: string }> }>("/sync/pins", { deviceId });
      if (pins.length === 0 && remote?.pins?.length) {
        await replacePins(remote.pins);
        await kvSet(PINS_PUSHED_KEY, JSON.stringify(remote.pins));
        return;
      }
    }
    if (pushed === signature) return;
    await rawPost("/sync/pins/set", { deviceId, deviceName: deviceName().slice(0, 120), pins });
    await kvSet(PINS_PUSHED_KEY, signature);
  } catch (error) {
    if (isNoAnswer(error)) throw error;
  }
}

// ---- bringing down what was chosen ----------------------------------------------

async function downloadPage(pageId: string): Promise<boolean> {
  let info: any;
  try {
    info = await rawPost<any>("/pages/info", { pageId });
  } catch (error) {
    if (error instanceof ServerError && [403, 404].includes(error.status)) return false;
    throw error;
  }
  if (!info?.id) return false;
  await savePageInfo(info);
  try {
    const comments = await rawPost<any>("/comments", { pageId: info.id, limit: 100 });
    await recordResponse("/comments", { pageId: info.id, limit: 100 }, comments);
  } catch (error) {
    if (isNoAnswer(error)) throw error;
  }
  const urls = fileUrlsInContent(skipVideos(info.content)).map(requestUrlForFile);
  if (urls.length) await ensureFiles(urls, getOfflineSettings().maxFileMb * 1024 * 1024);
  if (info.isBase) await downloadBase(info.id);
  return true;
}

// A base: its definition and its rows, under the requests the screens make.
async function downloadBase(pageId: string): Promise<void> {
  try {
    await recordResponse("/bases/info", { pageId }, await rawPost<any>("/bases/info", { pageId }));
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body = { pageId, limit: 100, ...(cursor ? { cursor } : {}) };
      const rows = await rawPost<any>("/bases/rows", body);
      await recordResponse("/bases/rows", body, rows);
      cursor = rows?.meta?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    const templates = { pageId, templates: true, limit: 100 };
    await recordResponse("/bases/rows", templates, await rawPost<any>("/bases/rows", templates));
  } catch (error) {
    if (isNoAnswer(error)) throw error;
  }
}

function skipVideos(content: any): any {
  if (getOfflineSettings().includeVideos || !content || typeof content !== "object") return content;
  const strip = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (node.type === "video") return null;
    if (!Array.isArray(node.content)) return node;
    return { ...node, content: node.content.map(strip).filter(Boolean) };
  };
  return strip(content);
}

async function download(): Promise<void> {
  const wanted = wantedPages();
  // not wanted any more and nothing unsent: free the space
  const dirty = new Set(await getDirtyDocs());
  const dropped = downloadedPages().filter((id) => !wanted.has(id) && !dirty.has(id) && !isDocOpen(id));
  if (dropped.length) {
    unmarkDownloaded(dropped);
    await removePageInfo(dropped);
    for (const id of dropped) {
      await forgetPageLocally(id);
      await deleteLocalDoc(id);
    }
    // off the device they are still found by title
    scheduleSystemSearch();
  }

  const missing = [...wanted].filter((id) => !isPageDownloaded(id));
  const stale = [...staleBodies].filter((id) => wanted.has(id) && isPageDownloaded(id));
  const total = missing.length + stale.length;
  if (total === 0 && staleComments.size === 0) return;
  let done = 0;
  if (total > 0) setStatus({ download: { done, total } });

  // bodies first, in batches; then the rest page by page
  const bodies = await pullDocs([...missing, ...stale]);
  for (const id of [...missing, ...stale]) {
    const ok = await downloadPage(id);
    staleBodies.delete(id);
    staleComments.delete(id);
    if (ok && (bodies.has(id) || isDocOpen(id))) {
      markDownloaded(id);
      noteTextChanged([id]);
    } else if (!ok) {
      unmarkDownloaded([id]);
    }
    done++;
    setStatus({ download: { done, total } });
  }

  for (const id of [...staleComments]) {
    staleComments.delete(id);
    if (!wanted.has(id)) continue;
    try {
      const comments = await rawPost<any>("/comments", { pageId: id, limit: 100 });
      await recordResponse("/comments", { pageId: id, limit: 100 }, comments);
    } catch (error) {
      if (isNoAnswer(error)) throw error;
    }
  }
}

// ---- for the settings screen --------------------------------------------------

export async function offlineUsage(): Promise<{ pages: number; pending: number; bytes: number | null }> {
  let bytes: number | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    bytes = typeof estimate?.usage === "number" ? estimate.usage : null;
  } catch {
    bytes = null;
  }
  return { pages: downloadedPages().length, pending: status.pending, bytes };
}

if (typeof window !== "undefined") {
  // handy from the console and for automated checks
  (window as any).__docmoreOffline = {
    status: getOfflineStatus,
    sync: syncNow,
    wipe: wipeOfflineData,
    pins: getPins,
    pin: (type: "space" | "page", id: string, value = true) =>
      setPinned(type, id, value).then(() => syncNow()),
    wanted: () => [...wantedPages()],
    downloaded: downloadedPages,
    dirty: getDirtyDocs,
    docState: localDocState,
    // the app's own API client, offline answers included
    request: (route: string, body?: unknown) =>
      import("@/lib/api-client.ts").then((module) => module.default.post(route, body ?? {})),
  };
}
