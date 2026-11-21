import { isNativeApp, nativeCall } from "@/lib/native/bridge.ts";

// Files (images, attachments) kept for offline use. In the desktop app the
// shell stores them on disk and serves them through its own URL handler. In
// a browser they live in Cache Storage and the service worker answers from
// there when the network does not.

const CACHE_NAME = "docmore-files";

function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

export function offlineFilesSupported(): boolean {
  return isNativeApp() || cacheAvailable();
}

// Downloads the files that are not on the device yet.
export async function ensureFiles(urls: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return { ok: [], failed: [] };
  if (isNativeApp()) {
    try {
      return await nativeCall<{ ok: string[]; failed: string[] }>("files.ensure", { urls: unique }, 10 * 60 * 1000);
    } catch {
      return { ok: [], failed: unique };
    }
  }
  if (!cacheAvailable()) return { ok: [], failed: unique };
  const cache = await caches.open(CACHE_NAME);
  const ok: string[] = [];
  const failed: string[] = [];
  for (const url of unique) {
    try {
      if (await cache.match(url)) {
        ok.push(url);
        continue;
      }
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        failed.push(url);
        continue;
      }
      await cache.put(url, response);
      ok.push(url);
    } catch {
      failed.push(url);
    }
  }
  return { ok, failed };
}

// Keeps bytes that only exist here (an image inserted offline) under the URL
// the page will ask for.
export async function putFile(url: string, blob: Blob): Promise<void> {
  if (isNativeApp()) {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
    }
    await nativeCall("files.put", { url, base64: btoa(binary), contentType: blob.type || "application/octet-stream" });
    return;
  }
  if (!cacheAvailable()) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    url,
    new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } }),
  );
}

export async function removeFiles(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  if (isNativeApp()) {
    await nativeCall("files.remove", { urls }).catch(() => {});
    return;
  }
  if (!cacheAvailable()) return;
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(urls.map((url) => cache.delete(url)));
}

export async function clearFiles(): Promise<void> {
  if (isNativeApp()) {
    await nativeCall("files.clear").catch(() => {});
    return;
  }
  if (cacheAvailable()) await caches.delete(CACHE_NAME);
}

export async function filesUsage(): Promise<{ bytes: number; count: number }> {
  if (isNativeApp()) {
    try {
      return await nativeCall<{ bytes: number; count: number }>("files.usage");
    } catch {
      return { bytes: 0, count: 0 };
    }
  }
  if (!cacheAvailable()) return { bytes: 0, count: 0 };
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  let bytes = 0;
  for (const request of keys) {
    const response = await cache.match(request);
    const length = Number(response?.headers.get("content-length") ?? 0);
    if (length) bytes += length;
    else if (response) bytes += (await response.clone().blob()).size;
  }
  return { bytes, count: keys.length };
}

// The file URLs a page body points at.
export function fileUrlsInContent(content: unknown): string[] {
  const urls = new Set<string>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    const attrs = node.attrs;
    if (attrs && typeof attrs === "object") {
      for (const key of ["src", "url", "href"]) {
        const value = attrs[key];
        if (typeof value === "string" && isOwnFileUrl(value)) urls.add(value);
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
    if (Array.isArray(node.marks)) node.marks.forEach(visit);
  };
  visit(content);
  return [...urls];
}

function isOwnFileUrl(value: string): boolean {
  return value.startsWith("/api/files/") || value.startsWith("/files/");
}

// "/files/<id>/<name>" is how bodies store them; requests go to "/api/files/...".
export function requestUrlForFile(value: string): string {
  return value.startsWith("/files/") ? `/api${value}` : value;
}
