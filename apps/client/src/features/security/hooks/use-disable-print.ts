import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { platformModifierKey } from "@/lib/utils.tsx";
import "@/features/security/styles/disable-print.css";

// Printing is the one export path the server cannot stop, so when export is
// off the client hides the document from the print stylesheet and swallows
// the print shortcut. Several views on one screen may each ask for the block
// (a page plus what it embeds); it stays until the last one lets go.

const BODY_ATTRIBUTE = "exportDisabled";
const NOTIFICATION_ID = "print-disabled";
const PUBLIC_PREFIXES = ["/share/", "/docs/"];

let nextHolderId = 0;
const holders = new Map<number, string>();
const subscribers = new Set<() => void>();

function activeReason(): string | null {
  const first = holders.values().next();
  return first.done ? null : first.value;
}

function isPrintShortcut(event: KeyboardEvent): boolean {
  if (event.shiftKey || event.altKey || !platformModifierKey(event)) {
    return false;
  }
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if (/^[a-z]$/.test(key)) {
    return key === "p";
  }
  // Non-Latin layouts report their own letter; fall back to the physical key.
  return event.code === "KeyP";
}

function onKeyDown(event: KeyboardEvent) {
  if (!isPrintShortcut(event)) return;
  event.preventDefault();
  if (event.repeat) return;
  notifications.show({
    id: NOTIFICATION_ID,
    message: activeReason(),
    color: "red",
  });
}

function applyState() {
  const reason = activeReason();
  if (reason) {
    document.body.dataset[BODY_ATTRIBUTE] = reason;
    document.addEventListener("keydown", onKeyDown);
  } else {
    delete document.body.dataset[BODY_ATTRIBUTE];
    document.removeEventListener("keydown", onKeyDown);
  }
  subscribers.forEach((notify) => notify());
}

function acquire(reason: string): () => void {
  const id = nextHolderId++;
  holders.set(id, reason);
  applyState();
  return () => {
    holders.delete(id);
    applyState();
  };
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

// Blocks printing while mounted with a non-null reason. Public share and
// docs pages never block: their content is public anyway.
export function useDisablePrint(reason: string | null) {
  const { pathname } = useLocation();
  const isPublicView = PUBLIC_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
  const effectiveReason = isPublicView ? null : reason;

  useEffect(() => {
    if (!effectiveReason) return;
    return acquire(effectiveReason);
  }, [effectiveReason]);
}

// The reason currently blocking printing, for menus that want to explain
// a disabled Print item.
export function usePrintBlockReason(): string | null {
  return useSyncExternalStore(subscribe, activeReason, activeReason);
}
