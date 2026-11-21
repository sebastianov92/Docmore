import { useSyncExternalStore } from "react";
import { onNativeEvent } from "@/lib/native/bridge.ts";

// "Online" here means the Docmore server answers, not that the machine has a
// network: a homelab behind a VPN can be unreachable while the wifi is fine.
// Everything that talks to the server asks this module first.

export type ConnectivityState = {
  // server answers and the person did not ask to work offline
  online: boolean;
  // the last probe reached the server
  reachable: boolean;
  // the person switched the app to offline on purpose
  workOffline: boolean;
};

const WORK_OFFLINE_KEY = "docmore.workOffline";
const PROBE_PATH = "/api/health/live";
const PROBE_TIMEOUT_MS = 4000;
const RETRY_DELAYS_MS = [2000, 5000, 10000, 15000];

type Listener = () => void;

const listeners = new Set<Listener>();
let reachable = true;
let workOffline = readWorkOffline();
let snapshot: ConnectivityState = buildSnapshot();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let probing: Promise<boolean> | null = null;
// the native shell can answer the probe itself (it owns the network stack)
let nativeProbe: (() => Promise<boolean>) | null = null;

function readWorkOffline(): boolean {
  try {
    return localStorage.getItem(WORK_OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

function buildSnapshot(): ConnectivityState {
  return { online: reachable && !workOffline, reachable, workOffline };
}

function publish() {
  const next = buildSnapshot();
  if (
    next.online === snapshot.online &&
    next.reachable === snapshot.reachable &&
    next.workOffline === snapshot.workOffline
  ) {
    return;
  }
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function getConnectivity(): ConnectivityState {
  return snapshot;
}

export function isOnline(): boolean {
  return snapshot.online;
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(
    subscribeConnectivity,
    getConnectivity,
    getConnectivity,
  );
}

// Runs the callback every time the app comes back online.
export function onBackOnline(callback: () => void): () => void {
  let wasOnline = snapshot.online;
  return subscribeConnectivity(() => {
    const nowOnline = snapshot.online;
    if (nowOnline && !wasOnline) callback();
    wasOnline = nowOnline;
  });
}

export function setWorkOffline(value: boolean) {
  workOffline = value;
  try {
    if (value) localStorage.setItem(WORK_OFFLINE_KEY, "1");
    else localStorage.removeItem(WORK_OFFLINE_KEY);
  } catch {
    // private mode: the switch still works for this tab
  }
  publish();
  if (!value) void probeServer();
}

export function setNativeProbe(probe: (() => Promise<boolean>) | null) {
  nativeProbe = probe;
}

function setReachable(value: boolean) {
  reachable = value;
  if (value) {
    retryAttempt = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  } else {
    scheduleRetry();
  }
  publish();
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay =
    RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void probeServer();
  }, delay);
}

async function runProbe(): Promise<boolean> {
  if (nativeProbe) {
    try {
      return await nativeProbe();
    } catch {
      return false;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_PATH, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Asks the server whether it is there. Concurrent callers share one request.
export function probeServer(): Promise<boolean> {
  if (!probing) {
    probing = runProbe()
      .then((ok) => {
        setReachable(ok);
        return ok;
      })
      .finally(() => {
        probing = null;
      });
  }
  return probing;
}

// A request got an answer from the server.
export function reportServerAnswered() {
  if (!reachable) setReachable(true);
}

// A request died without an answer (or a proxy answered for a dead server):
// confirm with a probe before switching the whole app to offline.
export function reportNetworkFailure() {
  if (reachable) void probeServer();
}

// The shell or the browser tells us the network changed.
export function reportNetworkChange(hasNetwork: boolean) {
  if (!hasNetwork) {
    setReachable(false);
    return;
  }
  void probeServer();
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => reportNetworkChange(false));
  window.addEventListener("online", () => reportNetworkChange(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !reachable) {
      void probeServer();
    }
  });
  // the desktop shell watches the network itself and says when it changes
  onNativeEvent<{ reachable?: boolean }>("net.changed", (payload) => {
    reportNetworkChange(payload?.reachable !== false);
  });
  // handy from the console and for automated checks
  (window as any).__docmoreConnectivity = {
    state: getConnectivity,
    setWorkOffline,
    probe: probeServer,
  };
}

let offlineMessage = () => "This needs a connection to the server";

// The app's translator, so the message reads in the person's language.
export function setOfflineMessage(message: () => string) {
  offlineMessage = message;
}

// What a request gets when there is no server and nothing local can answer.
// It carries a response-shaped message because that is where the app's error
// handlers look for the text to show.
export class OfflineError extends Error {
  readonly isOffline = true;
  readonly code = "ERR_OFFLINE";
  readonly status = 0;
  config: unknown;
  response: { status: number; data: { message: string } };

  constructor(config?: unknown) {
    const message = offlineMessage();
    super(message);
    this.name = "OfflineError";
    this.config = config;
    this.response = { status: 0, data: { message } };
  }
}

export function isOfflineError(error: unknown): error is OfflineError {
  return Boolean(error && (error as any).isOffline === true);
}
