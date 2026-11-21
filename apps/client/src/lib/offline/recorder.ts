import {
  idbBulkDelete,
  idbCount,
  idbDelete,
  idbGet,
  idbGetAll,
  idbOldestKeys,
  idbPut,
  kvGet,
  kvSet,
} from "./idb.ts";
import { stableStringify } from "./ids.ts";

// Record and replay. While the server answers, the answers to read requests
// are kept by (route, body). With no server the same request gets the last
// answer it had. That alone makes every screen the person already visited
// open offline; the handlers add the parts that need more than a replay.

export type Recorded = {
  key: string;
  route: string;
  body: unknown;
  data: unknown;
  at: number;
};

const MAX_RECORDS = 4000;
const TRIM_BATCH = 800;
let writesSinceTrim = 0;

// Reads end in one of these, or are a bare collection.
const READ_SUFFIX =
  /\/(info|ids|count|status|me|public|visible|installed|config|members|lookup|references|recent|sidebar-pages|breadcrumbs|for-page|entitlements|attachments|my-work|browse|created-by-user|verifications|version|watch-status|unread-count|permission-info|backlinks-count|verification-info|views|forms|rows|mine|tree|history)$/;

const READ_ROOTS = new Set([
  "/spaces",
  "/comments",
  "/favorites",
  "/groups",
  "/templates",
  "/bases",
  "/shares",
  "/integrations",
  "/notifications",
  "/ai/skills",
]);

// Never kept: secrets, private chats, things that only make sense live.
const NEVER =
  /^\/(auth|oauth|sync|search|search-attachments|analytics|billing|audit|sessions|sso|scim|scim-tokens|siem|webhooks|api-keys|mfa|files|attachments|clipper|license|unsplash|ai\/generate|ai\/chats|ai\/research|ai\/meetings|ai\/mcp-servers|ai\/settings|ai\/providers|workspace\/invites|workspace\/domains|pdf-export|docx-export)(\/|$)/;

export function normalizeRoute(url: string | undefined): string {
  if (!url) return "";
  let route = url.split("?")[0].split("#")[0];
  if (route.startsWith("http")) {
    try {
      route = new URL(route).pathname;
    } catch {
      // keep as is
    }
  }
  if (route.startsWith("/api/")) route = route.slice(4);
  if (!route.startsWith("/")) route = `/${route}`;
  return route.replace(/\/+$/, "") || "/";
}

export function isRecordable(route: string): boolean {
  if (NEVER.test(route)) return false;
  return READ_ROOTS.has(route) || READ_SUFFIX.test(route);
}

export function recordKey(route: string, body: unknown): string {
  return `${route}|${stableStringify(body ?? {})}`;
}

export async function recordResponse(route: string, body: unknown, data: unknown): Promise<void> {
  const record: Recorded = { key: recordKey(route, body), route, body: body ?? {}, data, at: Date.now() };
  await idbPut("responses", record);
  writesSinceTrim++;
  if (writesSinceTrim >= 200) {
    writesSinceTrim = 0;
    void trim();
  }
}

async function trim(): Promise<void> {
  try {
    if ((await idbCount("responses")) <= MAX_RECORDS) return;
    await idbBulkDelete("responses", await idbOldestKeys("responses", "at", TRIM_BATCH));
  } catch {
    // trimming is best effort
  }
}

export async function replay(route: string, body: unknown): Promise<{ found: boolean; data?: unknown }> {
  const record = await idbGet<Recorded>("responses", recordKey(route, body));
  return record ? { found: true, data: record.data } : { found: false };
}

export async function recordedFor(route: string): Promise<Recorded[]> {
  return idbGetAll<Recorded>("responses", "route", route);
}

// Changes the kept answers of a route in place (a comment written offline
// shows up in the list the next time it is asked for).
export async function patchRecorded(
  route: string,
  match: (body: any) => boolean,
  mutate: (data: any, body: any) => unknown | void,
): Promise<number> {
  let patched = 0;
  for (const record of await recordedFor(route)) {
    if (!match(record.body)) continue;
    const result = mutate(record.data, record.body);
    if (result !== undefined) record.data = result;
    await idbPut("responses", record);
    patched++;
  }
  return patched;
}

export async function forgetRecorded(route: string, match: (body: any) => boolean): Promise<void> {
  for (const record of await recordedFor(route)) {
    if (match(record.body)) await idbDelete("responses", record.key);
  }
}

// ---- pages ---------------------------------------------------------------

export type PageInfo = Record<string, any> & { id: string; slugId: string };

export async function savePageInfo(page: PageInfo): Promise<void> {
  if (!page?.id || !page.slugId) return;
  await idbPut("pages", { ...page, savedAt: Date.now() });
}

export async function getPageInfo(idOrSlug: string): Promise<PageInfo | undefined> {
  const byId = await idbGet<PageInfo>("pages", idOrSlug);
  if (byId) return byId;
  const bySlug = await idbGetAll<PageInfo>("pages", "slugId", idOrSlug);
  return bySlug[0];
}

export async function patchPageInfo(idOrSlug: string, patch: Record<string, unknown>): Promise<PageInfo | undefined> {
  const page = await getPageInfo(idOrSlug);
  if (!page) return undefined;
  const next = { ...page, ...patch };
  await idbPut("pages", next);
  return next;
}

export async function removePageInfo(ids: string[]): Promise<void> {
  await idbBulkDelete("pages", ids);
}

export async function allPageInfos(): Promise<PageInfo[]> {
  return idbGetAll<PageInfo>("pages");
}

// ---- who am I, which spaces ------------------------------------------------

export type Me = { user: Record<string, any>; workspace: Record<string, any> };
export type SpaceBrief = Record<string, any> & { id: string; name: string; slug: string };

export async function saveMe(me: Me): Promise<void> {
  if (me?.user?.id) await kvSet("me", me);
}

export function getMe(): Promise<Me | undefined> {
  return kvGet<Me>("me");
}

export async function saveSpaces(spaces: SpaceBrief[]): Promise<void> {
  if (!spaces.length) return;
  const known = (await kvGet<Record<string, SpaceBrief>>("spaces")) ?? {};
  for (const space of spaces) {
    if (space?.id) known[space.id] = { ...known[space.id], ...space };
  }
  await kvSet("spaces", known);
}

export async function getSpace(idOrSlug: string): Promise<SpaceBrief | undefined> {
  const known = (await kvGet<Record<string, SpaceBrief>>("spaces")) ?? {};
  return known[idOrSlug] ?? Object.values(known).find((space) => space.slug === idOrSlug);
}

export async function getSpaces(): Promise<SpaceBrief[]> {
  return Object.values((await kvGet<Record<string, SpaceBrief>>("spaces")) ?? {});
}
