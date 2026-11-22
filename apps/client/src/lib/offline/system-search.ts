import { nativeCan, nativeSend } from "@/lib/native/bridge.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { kvGet, kvSet } from "./idb.ts";
import { isPageDownloaded } from "./pins.ts";
import { getPageInfo, getSpaces } from "./recorder.ts";
import { contentText } from "./search.ts";
import { subscribeTree, treeAll } from "./tree-store.ts";

// In the desktop app the system search finds every page the person can see:
// by its title always, and by its text too when the page is on the device.
// This module keeps what the system search was told in step with the page
// tree; nothing else talks to it.

export type SearchRow = { id: string; slugId: string; title: string | null; spaceId: string; localOnly?: boolean };
export type SearchSpace = { id: string; slug?: string | null; name?: string | null };
export type SearchItem = { id: string; title: string; detail: string; path: string; withText: boolean };
export type SearchPlan = { index: SearchItem[]; remove: string[]; sent: Record<string, string> };

const SENT_KEY = "spotlight.sent";
const TITLES_PER_MESSAGE = 400;
const TEXTS_PER_MESSAGE = 20;
const TEXT_CHARS = 20_000;
const SETTLE_MS = 2500;

// What to tell the system search so it matches the tree. `sent` is what it
// was told before (page id -> a mark of what was sent); `redo` are pages
// whose text changed on the device since.
export function planSystemSearch(
  rows: SearchRow[],
  spaces: SearchSpace[],
  sent: Record<string, string>,
  hasText: (pageId: string) => boolean,
  redo: ReadonlySet<string> = new Set(),
): SearchPlan {
  const bySpace = new Map(spaces.map((space) => [space.id, space]));
  const next: Record<string, string> = {};
  const index: SearchItem[] = [];
  for (const row of rows) {
    // a page that only exists here has no address yet
    if (row.localOnly) continue;
    const space = bySpace.get(row.spaceId);
    if (!space?.slug) continue;
    const title = row.title?.trim() || "Untitled";
    const detail = space.name?.trim() || "";
    const withText = hasText(row.id);
    const mark = [title, space.slug, row.slugId, detail, withText ? "text" : ""].join("\n");
    next[row.id] = mark;
    if (sent[row.id] !== mark || (withText && redo.has(row.id))) {
      index.push({ id: row.id, title, detail, path: buildPageUrl(space.slug, row.slugId, row.title ?? undefined), withText });
    }
  }
  const remove = Object.keys(sent).filter((id) => next[id] === undefined);
  return { index, remove, sent: next };
}

let sent: Record<string, string> | null = null;
const stale = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;
let unsubscribe: (() => void) | null = null;

export function startSystemSearch(): void {
  if (!nativeCan("spotlight") || unsubscribe) return;
  unsubscribe = subscribeTree(scheduleSystemSearch);
  scheduleSystemSearch();
}

export function stopSystemSearch(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function scheduleSystemSearch(): void {
  if (!nativeCan("spotlight")) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncSystemSearch();
  }, SETTLE_MS);
}

// The text of these pages changed on the device (downloaded, or downloaded again).
export function noteTextChanged(pageIds: string[]): void {
  for (const id of pageIds) stale.add(id);
  scheduleSystemSearch();
}

// Nothing of this person stays in the system search.
export async function resetSystemSearch(): Promise<void> {
  sent = {};
  stale.clear();
  if (nativeCan("spotlight")) nativeSend("spotlight.clear");
  await kvSet(SENT_KEY, {}).catch(() => {});
}

export async function syncSystemSearch(): Promise<void> {
  if (!nativeCan("spotlight")) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  const redo = new Set(stale);
  stale.clear();
  try {
    if (!sent) sent = (await kvGet<Record<string, string>>(SENT_KEY)) ?? {};
    const [rows, spaces] = await Promise.all([treeAll(), getSpaces()]);
    const plan = planSystemSearch(rows, spaces as SearchSpace[], sent, isPageDownloaded, redo);
    const titles = plan.index.filter((item) => !item.withText);
    const texts = plan.index.filter((item) => item.withText);
    for (let i = 0; i < titles.length; i += TITLES_PER_MESSAGE) {
      nativeSend("spotlight.index", {
        items: titles.slice(i, i + TITLES_PER_MESSAGE).map(({ withText: _withText, ...item }) => ({ ...item, text: "" })),
      });
    }
    for (let i = 0; i < texts.length; i += TEXTS_PER_MESSAGE) {
      const items = [];
      for (const { withText: _withText, ...item } of texts.slice(i, i + TEXTS_PER_MESSAGE)) {
        const info = await getPageInfo(item.id).catch(() => undefined);
        items.push({ ...item, text: info ? contentText(info.content).slice(0, TEXT_CHARS) : "" });
      }
      nativeSend("spotlight.index", { items });
    }
    if (plan.remove.length) nativeSend("spotlight.remove", { ids: plan.remove });
    sent = plan.sent;
    if (plan.index.length || plan.remove.length) await kvSet(SENT_KEY, sent);
  } catch {
    // system search is a convenience; what was not sent is sent next time
    for (const id of redo) stale.add(id);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleSystemSearch();
    }
  }
}
