import axios from "axios";
import { reportNetworkFailure, reportServerAnswered } from "./connectivity.ts";
import { putFile } from "./files.ts";
import { idbDelete, idbGet, idbPut } from "./idb.ts";
import { uuidv7 } from "./ids.ts";
import { OutboxOp, enqueue } from "./outbox.ts";
import { ServerError } from "./raw-api.ts";
import { getMe } from "./recorder.ts";
import { treeGet } from "./tree-store.ts";

// Files added to a page with no server. The bytes stay on the device under
// the URL the page will ask for, so the image shows right away, and the
// upload waits in the queue with the id it will have on the server.

type StoredBlob = { key: string; blob: Blob; name: string; type: string };

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (cleaned || "file").slice(0, 200);
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// True for the uploads that can wait: a new file for a page. Replacing an
// existing file (diagrams) and page covers need the server.
export function canQueueUpload(form: FormData): boolean {
  const file = form.get("file");
  return (
    typeof Blob !== "undefined" &&
    file instanceof Blob &&
    typeof form.get("pageId") === "string" &&
    !form.get("attachmentId") &&
    !form.get("type")
  );
}

export async function queueOfflineUpload(form: FormData): Promise<Record<string, unknown>> {
  const file = form.get("file") as File;
  const pageId = String(form.get("pageId"));
  const id = uuidv7();
  const name = safeName((file as File).name ?? "file");
  const type = file.type || "application/octet-stream";
  const url = `/api/files/${id}/${name}`;

  await idbPut("blobs", { key: id, blob: file, name, type } satisfies StoredBlob);
  await putFile(url, file);
  await enqueue({
    route: "/files/upload",
    body: { blobKey: id, pageId, fileName: name },
    kind: "file.upload",
    title: name,
    pageId,
  });

  const me = await getMe();
  const row = await treeGet(pageId);
  const now = new Date().toISOString();
  return {
    id,
    fileName: name,
    fileSize: file.size,
    fileExt: extension(name),
    mimeType: type,
    type: "file",
    creatorId: me?.user?.id ?? null,
    pageId,
    spaceId: row?.spaceId ?? null,
    workspaceId: me?.workspace?.id ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    url,
  };
}

// Sends one queued upload. Throws ServerError when the server refused it.
export async function sendQueuedUpload(op: OutboxOp): Promise<unknown> {
  const stored = await idbGet<StoredBlob>("blobs", op.body.blobKey);
  if (!stored) {
    // the bytes are gone (storage cleared): nothing to send
    throw new ServerError(410, "The file is no longer on this device", null);
  }
  const form = new FormData();
  // fields first: the server reads them before the file
  form.append("newAttachmentId", stored.key);
  form.append("pageId", op.body.pageId);
  form.append("file", new File([stored.blob], stored.name, { type: stored.type }));
  try {
    const response = await axios.post("/api/files/upload", form, {
      withCredentials: true,
      headers: { "Idempotency-Key": op.id },
    });
    reportServerAnswered();
    await idbDelete("blobs", stored.key);
    return response.data;
  } catch (error: any) {
    if (error?.response) {
      reportServerAnswered();
      throw new ServerError(
        error.response.status,
        String(error.response.data?.message ?? error.message ?? "Upload failed"),
        error.response.data,
      );
    }
    reportNetworkFailure();
    throw error;
  }
}

export async function forgetQueuedUpload(op: OutboxOp): Promise<void> {
  if (op.body?.blobKey) await idbDelete("blobs", op.body.blobKey).catch(() => {});
}
