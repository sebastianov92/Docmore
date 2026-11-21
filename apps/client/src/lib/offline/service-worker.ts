import { isNativeApp } from "@/lib/native/bridge.ts";
import { kvGet, kvSet } from "./idb.ts";
import { rawGet } from "./raw-api.ts";

// Browser side of the service worker: register it, and once per client
// build ask it to bring the whole web client into its cache.

const SHELL_HASH_KEY = "shell.hash";

export function serviceWorkerSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    !isNativeApp() &&
    !import.meta.env.DEV
  );
}

export async function registerServiceWorker(): Promise<void> {
  if (!serviceWorkerSupported()) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "precached" && data.ok && data.hash) {
        void kvSet(SHELL_HASH_KEY, data.hash).catch(() => {});
      }
    });
  } catch {
    // the app works without it, only the shell needs the server then
  }
}

// Called while the server answers: makes sure this build of the client is
// fully in the cache.
export async function ensureShellCached(): Promise<void> {
  if (!serviceWorkerSupported()) return;
  try {
    const manifest = await rawGet<{ hash: string; files: Array<{ path: string }> }>("/sync/client-bundle");
    if (!manifest?.hash || (await kvGet<string>(SHELL_HASH_KEY)) === manifest.hash) return;
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({
      type: "precache",
      hash: manifest.hash,
      paths: manifest.files.map((file) => file.path),
    });
  } catch {
    // next time
  }
}
