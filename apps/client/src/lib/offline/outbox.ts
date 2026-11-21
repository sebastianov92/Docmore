import { idbDelete, idbGetAll, idbPut } from "./idb.ts";
import { uuidv7 } from "./ids.ts";

// Writes made with no server wait here, in order. Each one carries the id it
// is sent with (Idempotency-Key), so a write whose answer got lost can be
// sent again without running twice.

export type OutboxOp = {
  seq?: number;
  id: string;
  route: string;
  body: any;
  // what it is, for the person: "page.create", "comment.create"...
  kind: string;
  title?: string;
  pageId?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

export type Conflict = {
  id: string;
  // a queued write the server refused, or a page body that could not go up
  type: "op" | "doc";
  kind: string;
  route?: string;
  body?: any;
  pageId?: string;
  title?: string;
  reason: string;
  status?: number;
  at: number;
};

const listeners = new Set<() => void>();
let pendingCount = 0;
let conflictCount = 0;
let counted = false;

function changed() {
  for (const listener of [...listeners]) listener();
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function outboxCounts(): { pending: number; conflicts: number } {
  return { pending: pendingCount, conflicts: conflictCount };
}

export async function refreshOutboxCounts(): Promise<void> {
  try {
    pendingCount = (await idbGetAll<OutboxOp>("outbox")).length;
    conflictCount = (await idbGetAll<Conflict>("conflicts")).length;
  } catch {
    pendingCount = 0;
    conflictCount = 0;
  }
  counted = true;
  changed();
}

export async function enqueue(op: Omit<OutboxOp, "seq" | "id" | "createdAt" | "attempts">): Promise<OutboxOp> {
  const full: OutboxOp = { ...op, id: uuidv7(), createdAt: Date.now(), attempts: 0 };
  full.seq = (await idbPut("outbox", full)) as number;
  if (!counted) await refreshOutboxCounts();
  else {
    pendingCount++;
    changed();
  }
  return full;
}

export async function listOutbox(): Promise<OutboxOp[]> {
  const ops = await idbGetAll<OutboxOp>("outbox");
  return ops.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function updateOp(op: OutboxOp): Promise<void> {
  await idbPut("outbox", op);
}

export async function removeOp(op: OutboxOp): Promise<void> {
  if (op.seq === undefined) return;
  await idbDelete("outbox", op.seq);
  pendingCount = Math.max(0, pendingCount - 1);
  changed();
}

export async function addConflict(conflict: Omit<Conflict, "id" | "at"> & { id?: string }): Promise<void> {
  await idbPut("conflicts", { ...conflict, id: conflict.id ?? uuidv7(), at: Date.now() });
  await refreshOutboxCounts();
}

export async function listConflicts(): Promise<Conflict[]> {
  const conflicts = await idbGetAll<Conflict>("conflicts");
  return conflicts.sort((a, b) => b.at - a.at);
}

export async function removeConflict(id: string): Promise<void> {
  await idbDelete("conflicts", id);
  await refreshOutboxCounts();
}

// Resolves once nothing is queued (or after the timeout). A page created
// offline does not exist on the server until its queued create went up, and
// the live editor must not knock on that door before.
export function whenOutboxSent(timeoutMs = 8000): Promise<void> {
  if (!counted || pendingCount === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeOutbox(() => {
      if (pendingCount === 0) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

export function resetOutboxCounts(): void {
  pendingCount = 0;
  conflictCount = 0;
  counted = false;
  changed();
}
