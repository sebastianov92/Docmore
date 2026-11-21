// Docmore service worker (browsers only; the desktop app serves the client
// itself). Two jobs:
//   - the app shell opens with no server (navigations fall back to the cached
//     index.html, scripts and styles come from the cache)
//   - files kept for offline use are answered from the cache when the
//     network does not answer
// API calls are never touched here: the page's own offline engine decides.

const SHELL = "docmore-shell-v1";
const FILES = "docmore-files";
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "precache" && Array.isArray(data.paths)) {
    event.waitUntil(
      precache(data.paths).then((ok) => {
        if (event.source) event.source.postMessage({ type: "precached", hash: data.hash, ok });
      }),
    );
  }
});

// Brings the whole web client into the cache so every screen opens offline,
// not only the ones already visited.
async function precache(paths) {
  const cache = await caches.open(SHELL);
  const wanted = new Set(paths.map((path) => "/" + path));
  let ok = true;
  const queue = [...wanted];
  const worker = async () => {
    while (queue.length) {
      const url = queue.pop();
      const hashed = url.startsWith("/assets/");
      try {
        if (hashed && (await cache.match(url))) continue;
        const response = await fetch(url, { cache: "no-cache" });
        if (response.ok) await cache.put(url, response);
        else ok = false;
      } catch (error) {
        ok = false;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // files of older builds
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (!wanted.has(path) && path !== "/") await cache.delete(request);
  }
  return ok;
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function navigation(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await Promise.race([fetch(request), timeout(NAVIGATION_TIMEOUT_MS)]);
    return response;
  } catch (error) {
    const shell = (await cache.match("/index.html")) || (await cache.match("/"));
    if (shell) return shell;
    throw error;
  }
}

async function asset(request, path) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  // content-hashed: what is cached is what the URL means forever
  if (cached && path.startsWith("/assets/")) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function file(request) {
  const cache = await caches.open(FILES);
  try {
    const response = await fetch(request);
    // a kept file stays current
    if (response.ok && (await cache.match(request, { ignoreSearch: true }))) {
      cache.put(new URL(request.url).pathname, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith("/api/files/") || path.startsWith("/api/attachments/")) {
    event.respondWith(file(request));
    return;
  }
  if (
    path.startsWith("/api/") ||
    path.startsWith("/socket.io") ||
    path.startsWith("/collab") ||
    path.startsWith("/mcp") ||
    path.startsWith("/.well-known") ||
    path === "/sw.js"
  ) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  event.respondWith(asset(request, path));
});
