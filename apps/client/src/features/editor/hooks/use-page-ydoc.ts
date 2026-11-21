import { useEffect, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

const LOCAL_OPEN_TIMEOUT = 2000;
const SERVER_SYNCED_KEY = "serverSynced";

type LoadedYdoc = { pageId: string; ydoc: Y.Doc };

type LocalCopy = {
  local: IndexeddbPersistence;
  // the stored copy came from the server at least once, or was written here
  usable: boolean;
};

const localCopies = new WeakMap<Y.Doc, LocalCopy>();

// True when the copy in IndexedDB is the real page (it synced with the server
// before, or it already holds content), so it is safe to open and edit with
// no server. An empty, never-synced copy is not: typing into it would later
// merge on top of a page the person never saw.
export function pageDocHasLocalCopy(ydoc: Y.Doc | null | undefined): boolean {
  if (!ydoc) return false;
  if (localCopies.get(ydoc)?.usable) return true;
  return ydoc.getXmlFragment("default").length > 0;
}

export function markPageDocServerSynced(ydoc: Y.Doc | null | undefined): void {
  if (!ydoc) return;
  const copy = localCopies.get(ydoc);
  if (!copy || copy.usable) return;
  copy.usable = true;
  try {
    void copy.local.set?.(SERVER_SYNCED_KEY, Date.now());
  } catch {
    // the marker is an optimisation, the content check still covers this page
  }
}

// Load the IndexedDB copy before joining the room, so the first sync sends
// the server our state vector and only the missing updates come back.
export function usePageYdoc(pageId: string): Y.Doc | null {
  const [loaded, setLoaded] = useState<LoadedYdoc | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const local = new IndexeddbPersistence(`page.${pageId}`, ydoc);
    const copy: LocalCopy = { local, usable: false };
    localCopies.set(ydoc, copy);
    let active = true;
    const release = () => {
      if (!active) return;
      setLoaded((current) =>
        current?.ydoc === ydoc ? current : { pageId, ydoc },
      );
    };

    local.whenSynced.then(async () => {
      try {
        const marker = await local.get?.(SERVER_SYNCED_KEY);
        if (marker) copy.usable = true;
      } catch {
        // no marker store: fall back to the content check
      }
      release();
    });
    // IndexedDB can be blocked or never open; the room then syncs the whole document.
    local._db.catch(release);
    const timeout = setTimeout(() => {
      if (!local.db) release();
    }, LOCAL_OPEN_TIMEOUT);

    return () => {
      active = false;
      clearTimeout(timeout);
      local.destroy().catch(() => {});
    };
  }, [pageId]);

  return loaded?.pageId === pageId ? loaded.ydoc : null;
}
