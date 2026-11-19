// A password-protected share hands the browser a short-lived token after
// the right password; it travels as a header on every request made from
// the share's pages (page info, tree, transclusions, embedded bases).
const KEY = "docmore:share-access:v1";

type Store = Record<string, string>;

function read(): Store {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function getShareAccessToken(shareId: string): string | null {
  return read()[shareId.toLowerCase()] ?? null;
}

export function setShareAccessToken(shareId: string, token: string): void {
  try {
    const store = read();
    store[shareId.toLowerCase()] = token;
    sessionStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // private window or blocked storage: the prompt simply shows again
  }
}

export function clearShareAccessToken(shareId: string): void {
  try {
    const store = read();
    delete store[shareId.toLowerCase()];
    sessionStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

// The share id in the current URL, when the browser is on a shared page.
export function currentShareId(): string | null {
  const match = window.location.pathname.match(/^\/share\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
