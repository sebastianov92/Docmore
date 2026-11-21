// The Docmore desktop app loads this same web client from its own origin
// (docmore-app://<profile>/) and proxies /api to the server. This module is
// the only place that knows how the two sides talk:
//
//   web -> native   window.webkit.messageHandlers.docmore.postMessage({ id, type, payload })
//   native -> web   window.__docmoreNativeReply(id, error, result)            (answers)
//                   window.dispatchEvent(new CustomEvent("docmore:native",    (events)
//                     { detail: { type, payload } }))
//
// In a browser none of it exists and every helper says so.

export type NativeInfo = {
  platform: "mac";
  appVersion: string;
  // origin of the Docmore server, e.g. https://wiki.example.com
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  // what this build of the shell can do: "files", "notify", "spotlight", "meetings"...
  capabilities?: string[];
};

declare global {
  interface Window {
    DOCMORE_NATIVE?: NativeInfo;
    __docmoreNativeReply?: (id: string, error: string | null, result: unknown) => void;
    webkit?: {
      messageHandlers?: Record<string, { postMessage: (message: unknown) => void }>;
    };
  }
}

const NATIVE_EVENT = "docmore:native";
const DEFAULT_TIMEOUT_MS = 30000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let counter = 0;

export function nativeInfo(): NativeInfo | null {
  if (typeof window === "undefined") return null;
  const info = window.DOCMORE_NATIVE;
  if (!info || !info.serverUrl) return null;
  return info;
}

export function isNativeApp(): boolean {
  return nativeInfo() !== null && Boolean(handler());
}

export function nativeCan(capability: string): boolean {
  return isNativeApp() && (nativeInfo()?.capabilities ?? []).includes(capability);
}

function handler() {
  return typeof window === "undefined"
    ? undefined
    : window.webkit?.messageHandlers?.docmore;
}

if (typeof window !== "undefined") {
  window.__docmoreNativeReply = (id, error, result) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  };
}

// Asks the shell to do something and waits for its answer.
export function nativeCall<T = unknown>(
  type: string,
  payload?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const target = handler();
  if (!target) return Promise.reject(new Error("Not running in the desktop app"));
  const id = `c${++counter}-${Date.now().toString(36)}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The desktop app did not answer "${type}"`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      target.postMessage({ id, type, payload: payload ?? null });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Tells the shell something without waiting (state for its menus, badges).
export function nativeSend(type: string, payload?: unknown): void {
  const target = handler();
  if (!target) return;
  try {
    target.postMessage({ id: null, type, payload: payload ?? null });
  } catch {
    // a shell that is going away
  }
}

// Listens to what the shell tells the page: "net.changed", "navigate", "command"...
export function onNativeEvent<T = unknown>(
  type: string,
  listener: (payload: T) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent).detail as { type?: string; payload?: T } | undefined;
    if (detail?.type === type) listener(detail.payload as T);
  };
  window.addEventListener(NATIVE_EVENT, wrapped);
  return () => window.removeEventListener(NATIVE_EVENT, wrapped);
}
