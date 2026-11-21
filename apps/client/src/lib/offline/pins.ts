import { useSyncExternalStore } from "react";
import { nativeInfo } from "@/lib/native/bridge.ts";
import { kvGet, kvSet } from "./idb.ts";
import { subscribeTree, treeAll, treeSubtree } from "./tree-store.ts";

// What the person chose to keep on this device: whole spaces, or a page with
// everything under it. Plus, if they want, the pages they opened lately.

export type Pin = { type: "space" | "page"; id: string };

export type OfflineSettings = {
  keepRecent: boolean;
  recentCount: number;
  includeVideos: boolean;
  // files larger than this stay on the server; 0 = no limit
  maxFileMb: number;
};

export type PageOfflineState =
  // chosen and on the device
  | "downloaded"
  // chosen, still coming
  | "pending"
  // not chosen: only on the server
  | "none";

const PINS_KEY = "pins";
const SETTINGS_KEY = "offline.settings";
const RECENTS_KEY = "recents";
const DOWNLOADED_KEY = "downloaded";
const DEVICE_KEY = "deviceId";

const DEFAULT_SETTINGS: OfflineSettings = {
  keepRecent: true,
  recentCount: 50,
  includeVideos: false,
  maxFileMb: 25,
};

let pins: Pin[] = [];
let settings: OfflineSettings = { ...DEFAULT_SETTINGS };
let recents: string[] = [];
// page id -> when it was last brought down
let downloaded: Record<string, number> = {};
// every page the device should hold, expanded from pins and recents
let wanted = new Set<string>();
// pages chosen through a pin (not just recently opened)
let pinnedPages = new Set<string>();
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();
let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
let downloadedWrite: ReturnType<typeof setTimeout> | null = null;

function changed() {
  version++;
  for (const listener of [...listeners]) listener();
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pinsVersion(): number {
  return version;
}

export async function loadPins(): Promise<void> {
  pins = (await kvGet<Pin[]>(PINS_KEY)) ?? [];
  settings = { ...DEFAULT_SETTINGS, ...((await kvGet<Partial<OfflineSettings>>(SETTINGS_KEY)) ?? {}) };
  recents = (await kvGet<string[]>(RECENTS_KEY)) ?? [];
  downloaded = (await kvGet<Record<string, number>>(DOWNLOADED_KEY)) ?? {};
  loaded = true;
  await recomputeWanted();
}

export function resetPins(): void {
  pins = [];
  settings = { ...DEFAULT_SETTINGS };
  recents = [];
  downloaded = {};
  wanted = new Set();
  pinnedPages = new Set();
  loaded = false;
  changed();
}

export function getPins(): Pin[] {
  return pins;
}

export function getOfflineSettings(): OfflineSettings {
  return settings;
}

export async function setOfflineSettings(patch: Partial<OfflineSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  await kvSet(SETTINGS_KEY, settings);
  await recomputeWanted();
}

export function isPinned(type: Pin["type"], id: string): boolean {
  return pins.some((pin) => pin.type === type && pin.id === id);
}

export async function setPinned(type: Pin["type"], id: string, value: boolean): Promise<void> {
  const without = pins.filter((pin) => !(pin.type === type && pin.id === id));
  pins = value ? [...without, { type, id }] : without;
  await kvSet(PINS_KEY, pins);
  await recomputeWanted();
}

export async function replacePins(next: Pin[]): Promise<void> {
  pins = next;
  await kvSet(PINS_KEY, pins);
  await recomputeWanted();
}

// A page was opened: it goes to the front of the recents.
export async function touchRecent(pageId: string): Promise<void> {
  if (!loaded) return;
  if (recents[0] === pageId) return;
  recents = [pageId, ...recents.filter((id) => id !== pageId)].slice(0, 200);
  await kvSet(RECENTS_KEY, recents);
  if (settings.keepRecent) scheduleRecompute();
}

function scheduleRecompute() {
  if (recomputeTimer) return;
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    void recomputeWanted();
  }, 250);
}

// a moved or new page may now sit under a pinned one
subscribeTree(() => {
  if (loaded && pins.length > 0) scheduleRecompute();
});

export async function recomputeWanted(): Promise<void> {
  const nextPinned = new Set<string>();
  const pinnedSpaces = new Set(pins.filter((pin) => pin.type === "space").map((pin) => pin.id));
  if (pinnedSpaces.size > 0) {
    for (const row of await treeAll()) {
      if (pinnedSpaces.has(row.spaceId)) nextPinned.add(row.id);
    }
  }
  for (const pin of pins) {
    if (pin.type !== "page") continue;
    const subtree = await treeSubtree(pin.id);
    if (subtree.length === 0) nextPinned.add(pin.id);
    for (const row of subtree) nextPinned.add(row.id);
  }
  const next = new Set(nextPinned);
  if (settings.keepRecent) {
    for (const id of recents.slice(0, settings.recentCount)) next.add(id);
  }
  pinnedPages = nextPinned;
  wanted = next;
  changed();
}

export function wantedPages(): Set<string> {
  return wanted;
}

export function isPageWanted(pageId: string): boolean {
  return wanted.has(pageId);
}

// True when the page is held because of a pin (its own or an ancestor's or
// its space's), not merely because it was opened lately.
export function isPagePinned(pageId: string): boolean {
  return pinnedPages.has(pageId);
}

export function pageOfflineState(pageId: string): PageOfflineState {
  if (downloaded[pageId]) return "downloaded";
  return wanted.has(pageId) ? "pending" : "none";
}

export function isPageDownloaded(pageId: string): boolean {
  return Boolean(downloaded[pageId]);
}

export function markDownloaded(pageId: string): void {
  downloaded[pageId] = Date.now();
  persistDownloaded();
  changed();
}

export function unmarkDownloaded(pageIds: string[]): void {
  let any = false;
  for (const id of pageIds) {
    if (downloaded[id]) {
      delete downloaded[id];
      any = true;
    }
  }
  if (any) {
    persistDownloaded();
    changed();
  }
}

export function downloadedPages(): string[] {
  return Object.keys(downloaded);
}

function persistDownloaded() {
  if (downloadedWrite) return;
  downloadedWrite = setTimeout(() => {
    downloadedWrite = null;
    void kvSet(DOWNLOADED_KEY, downloaded).catch(() => {});
  }, 300);
}

// A stable name for this browser or app install, for the server-side copy of
// the pins.
export async function getDeviceId(): Promise<string> {
  const native = nativeInfo();
  if (native?.deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(native.deviceId)) return native.deviceId;
  let id = await kvGet<string>(DEVICE_KEY);
  if (!id) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    id = `web-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    await kvSet(DEVICE_KEY, id);
  }
  return id;
}

export function deviceName(): string {
  const native = nativeInfo();
  if (native?.deviceName) return native.deviceName;
  const agent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Chrome\//.test(agent)
      ? "Chrome"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const os = /Mac/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// ---- hooks -------------------------------------------------------------------

export function usePinsVersion(): number {
  return useSyncExternalStore(subscribePins, pinsVersion, pinsVersion);
}

export function usePageOfflineState(pageId: string | undefined): PageOfflineState {
  usePinsVersion();
  return pageId ? pageOfflineState(pageId) : "none";
}
