import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteLocalPageData } from "./local-page-data";

function stubIndexedDB(names: string[]) {
  const deleteDatabase = vi.fn(() => {
    const request: Record<string, () => void> = {};
    setTimeout(() => request.onsuccess?.());
    return request;
  });
  vi.stubGlobal("indexedDB", {
    databases: async () => names.map((name) => ({ name, version: 1 })),
    deleteDatabase,
  });
  return deleteDatabase;
}

describe("deleteLocalPageData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the page databases and the offline store, nothing else", async () => {
    const deleteDatabase = stubIndexedDB(["page.a", "page.b", "other-db"]);

    await deleteLocalPageData();

    const deleted = (deleteDatabase.mock.calls as unknown as string[][]).map((call) => call[0]);
    expect(deleted).toContain("page.a");
    expect(deleted).toContain("page.b");
    // queued changes and downloaded pages of the person signing out
    expect(deleted).toContain("docmore-offline");
    expect(deleted).not.toContain("other-db");
  });

  it("does nothing when the browser cannot list databases", async () => {
    vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn() });

    await expect(deleteLocalPageData()).resolves.toBeUndefined();
  });
});
