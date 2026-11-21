import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import api from "@/lib/api-client.ts";
import { clearDocDirty, deleteLocalDoc, markDocDirty, pageDatabaseName } from "./docs.ts";
import { syncNow } from "./engine.ts";
import { idbDelete } from "./idb.ts";
import { Conflict, enqueue, removeConflict } from "./outbox.ts";
import { unmarkDownloaded } from "./pins.ts";
import { rawPost } from "./raw-api.ts";
import { getPageInfo } from "./recorder.ts";

// What the person can do with a change the server did not take.

// Throw the local change away.
export async function discardConflict(conflict: Conflict): Promise<void> {
  if (conflict.type === "doc" && conflict.pageId) {
    clearDocDirty(conflict.pageId);
    // the local copy holds edits the server will never have: start clean
    await deleteLocalDoc(conflict.pageId);
    unmarkDownloaded([conflict.pageId]);
  }
  if (conflict.type === "op" && conflict.route === "/files/upload" && conflict.body?.blobKey) {
    // the bytes waited for a retry that will not come
    await idbDelete("blobs", conflict.body.blobKey).catch(() => {});
  }
  await removeConflict(conflict.id);
  void syncNow();
}

// Try again as it was.
export async function retryConflict(conflict: Conflict): Promise<void> {
  if (conflict.type === "op" && conflict.route) {
    await enqueue({
      route: conflict.route,
      body: conflict.body,
      kind: conflict.kind,
      title: conflict.title,
      pageId: conflict.pageId,
    });
  } else if (conflict.pageId) {
    markDocDirty(conflict.pageId);
  }
  await removeConflict(conflict.id);
  void syncNow();
}

// The page went to the trash on the server while it was edited here: bring
// it back and send the edits.
export async function restoreAndSend(conflict: Conflict): Promise<void> {
  if (!conflict.pageId) return;
  await rawPost("/pages/restore", { pageId: conflict.pageId });
  markDocDirty(conflict.pageId);
  await removeConflict(conflict.id);
  void syncNow();
}

async function openDoc(pageId: string): Promise<{ doc: Y.Doc; local: IndexeddbPersistence }> {
  const doc = new Y.Doc();
  const local = new IndexeddbPersistence(pageDatabaseName(pageId), doc);
  await local.whenSynced;
  return { doc, local };
}

// Keep the local version as a page of its own, next to the original.
export async function saveAsNewPage(conflict: Conflict, suffix: string): Promise<{ id: string; slugId: string; title: string } | null> {
  if (!conflict.pageId) return null;
  const info = await getPageInfo(conflict.pageId);
  const spaceId = info?.spaceId;
  if (!spaceId) return null;
  const title = `${info?.title ?? conflict.title ?? ""} ${suffix}`.trim();
  const created = (await api.post("/pages/create", { spaceId, title })) as any;
  const page = created?.data ?? created;
  if (!page?.id) return null;

  const source = await openDoc(conflict.pageId);
  const target = await openDoc(page.id);
  try {
    Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc));
    await target.local.set("serverSynced", Date.now());
    // let the write reach IndexedDB before both are closed
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    await source.local.destroy().catch(() => {});
    await target.local.destroy().catch(() => {});
    source.doc.destroy();
    target.doc.destroy();
  }
  markDocDirty(page.id);
  await discardConflict(conflict);
  return { id: page.id, slugId: page.slugId, title };
}
