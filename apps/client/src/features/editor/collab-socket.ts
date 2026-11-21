import {
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import { getCollaborationUrl } from "@/lib/config.ts";
import { isOnline, subscribeConnectivity } from "@/lib/offline/connectivity.ts";

const RELEASE_GRACE_MS = 5000;

let socket: HocuspocusProviderWebsocket | null = null;
let editorCount = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

export function getCollabSocket(): HocuspocusProviderWebsocket {
  if (!socket) {
    socket = new HocuspocusProviderWebsocket({
      url: getCollaborationUrl(),
      autoConnect: false,
    });
  }
  return socket;
}

export function acquireCollabSocket(): void {
  editorCount++;
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  connectIfAllowed();
}

function connectIfAllowed(): void {
  if (editorCount === 0 || !isOnline()) return;
  const collabSocket = getCollabSocket();
  collabSocket.shouldConnect = true;
  if (collabSocket.status === WebSocketStatus.Disconnected) {
    collabSocket.connect();
  }
}

// Offline the socket stays closed (no retry storm against a dead server); the
// editor keeps writing to the local copy and the room syncs once we are back.
subscribeConnectivity(() => {
  if (isOnline()) {
    connectIfAllowed();
  } else {
    socket?.disconnect();
  }
});

export function releaseCollabSocket(): void {
  editorCount--;
  if (editorCount > 0) return;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (editorCount === 0) {
      socket?.disconnect();
    }
  }, RELEASE_GRACE_MS);
}
