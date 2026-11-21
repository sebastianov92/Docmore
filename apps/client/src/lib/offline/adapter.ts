import axios, { AxiosAdapter, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { OfflineError, isOnline, probeServer } from "./connectivity.ts";
import { DROPPED_OFFLINE, MUTATIONS, READERS } from "./handlers.ts";
import { enqueue } from "./outbox.ts";
import { canQueueUpload, queueOfflineUpload } from "./uploads.ts";
import {
  isRecordable,
  normalizeRoute,
  recordResponse,
  replay,
  saveMe,
  savePageInfo,
  saveSpaces,
} from "./recorder.ts";

// Sits between the app's API client and the network.
//
// Online: requests go to the server as always; answers to reads are recorded
// and writes the engine knows about are mirrored into the local data.
// Offline: reads are answered locally, known writes are done locally and
// queued, everything else fails at once with an OfflineError.

const network = axios.getAdapter(["xhr", "fetch"]);

// set by the engine once the local stores are usable; before that (or if
// IndexedDB is unavailable) the adapter is a plain pass-through
let enabled = false;
let onQueued: (() => void) | null = null;

export function enableOfflineAnswers(options: { onQueued?: () => void } = {}): void {
  enabled = true;
  onQueued = options.onQueued ?? null;
}

export function disableOfflineAnswers(): void {
  enabled = false;
  onQueued = null;
}

function parseBody(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data ?? {};
}

function isJsonBody(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !(typeof FormData !== "undefined" && body instanceof FormData) &&
    !(typeof Blob !== "undefined" && body instanceof Blob)
  );
}

function localResponse(config: InternalAxiosRequestConfig, data: unknown, route: string): AxiosResponse {
  return {
    data: { data, success: true, status: 200 },
    status: 200,
    statusText: "OK",
    headers: { "x-docmore-offline": "1" } as any,
    config,
    request: { responseURL: `${window.location.origin}/api${route}` },
  };
}

function offlineFailure(config: InternalAxiosRequestConfig): OfflineError {
  return new OfflineError(config);
}

async function answerOffline(
  config: InternalAxiosRequestConfig,
  route: string,
  body: unknown,
): Promise<AxiosResponse> {
  if (!enabled || config.responseType === "blob") throw offlineFailure(config);

  // a file added to a page: kept here, sent later
  if (route === "/files/upload" && typeof FormData !== "undefined" && body instanceof FormData) {
    if (!canQueueUpload(body)) throw offlineFailure(config);
    const attachment = await queueOfflineUpload(body);
    onQueued?.();
    // this endpoint answers without the usual envelope
    return { ...localResponse(config, null, route), data: attachment };
  }

  if (!isJsonBody(body)) throw offlineFailure(config);

  const mutation = MUTATIONS[route];
  if (mutation) {
    if (mutation.canQueue && !mutation.canQueue(body)) throw offlineFailure(config);
    const result = await mutation.apply({ body });
    const info = mutation.describe(body, result);
    await enqueue({ route, body: result.body ?? body, ...info });
    onQueued?.();
    return localResponse(config, result.data, route);
  }

  const reader = READERS[route];
  if (reader) {
    const data = await reader(body);
    if (data !== undefined) return localResponse(config, data, route);
  }

  if (isRecordable(route)) {
    const hit = await replay(route, body);
    if (hit.found) return localResponse(config, hit.data, route);
  }

  if (DROPPED_OFFLINE.has(route)) return localResponse(config, {}, route);

  throw offlineFailure(config);
}

// Keeps the local data in step with what just happened online.
async function observe(route: string, body: unknown, response: AxiosResponse): Promise<void> {
  // Recording starts with the very first request, before the engine knows
  // who is signed in: what the app loads at start must be there for the next
  // time. (If the device held someone else's data, the engine wipes it all.)
  if (response.status < 200 || response.status >= 300) return;
  // at this point axios has not parsed the body yet
  let envelope: unknown = response.data;
  if (typeof envelope === "string") {
    if (!envelope.startsWith("{")) return;
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return;
    }
  }
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) return;
  const data = (envelope as { data: unknown }).data;
  try {
    const mutation = MUTATIONS[route];
    if (mutation && isJsonBody(body)) {
      if (enabled) await mutation.apply({ body, server: data ?? {} });
      return;
    }
    if (!isRecordable(route) || !isJsonBody(body)) return;
    await recordResponse(route, body, data);
    if (route === "/pages/info" && data && typeof data === "object") {
      await savePageInfo(data as any);
    } else if (route === "/users/me") {
      await saveMe(data as any);
    } else if (route === "/spaces" && Array.isArray((data as any)?.items)) {
      await saveSpaces((data as any).items);
    } else if (route === "/spaces/info" && (data as any)?.id) {
      await saveSpaces([data as any]);
    }
  } catch {
    // the local copy is a convenience; it must never break the real request
  }
}

function isNoAnswer(error: unknown): boolean {
  const axiosError = error as AxiosError;
  return Boolean(axiosError?.isAxiosError) && !axiosError.response && axiosError.code !== "ERR_CANCELED";
}

export const offlineAdapter: AxiosAdapter = async (config) => {
  const route = normalizeRoute(config.url);
  const body = parseBody(config.data);

  if (!isOnline()) return answerOffline(config, route, body);

  try {
    const response = await network(config);
    void observe(route, body, response);
    return response;
  } catch (error) {
    // The server stopped answering mid-session: confirm, then answer locally
    // so the screen that asked does not see an error at all.
    if (enabled && isNoAnswer(error) && !(await probeServer())) {
      return answerOffline(config, route, body);
    }
    throw error;
  }
};
