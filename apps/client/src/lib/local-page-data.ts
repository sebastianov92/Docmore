// y-indexeddb names each database after the collab document, page.<pageId>
const PAGE_DATABASE_PREFIX = "page.";

export async function deleteLocalPageData(): Promise<void> {
  try {
    // queued changes, downloaded pages and files of the person signing out
    const { wipeOfflineData } = await import("@/lib/offline/engine.ts");
    await wipeOfflineData();
  } catch {
    // local cleanup must never block logout
  }
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    const pageDatabaseNames = databases
      .map((database) => database.name)
      .filter((name) => name?.startsWith(PAGE_DATABASE_PREFIX));

    await Promise.all(
      pageDatabaseNames.map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    // local cleanup must never block logout
  }
}
