import { describe, expect, it } from "vitest";
import { looksLikeUuid, newSlugId, stableStringify, uuidv7 } from "./ids";

describe("offline ids", () => {
  it("mints version 7 uuids that sort by time", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_700_000_000_001);
    expect(looksLikeUuid(early)).toBe(true);
    expect(early[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(early[19]);
    expect(early < late).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });

  it("mints slug ids shaped like the server's", () => {
    for (let i = 0; i < 20; i++) expect(newSlugId()).toMatch(/^[0-9A-Za-z]{10}$/);
  });

  it("gives the same key to the same request whatever the key order", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify({ limit: 100, pageId: "p" })).toBe('{"limit":100,"pageId":"p"}');
  });
});
