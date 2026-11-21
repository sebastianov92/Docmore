import { describe, expect, it } from "vitest";
import { isRecordable, normalizeRoute, recordKey } from "./recorder";

describe("offline recorder routes", () => {
  it("normalizes urls to api routes", () => {
    expect(normalizeRoute("/pages/info")).toBe("/pages/info");
    expect(normalizeRoute("/api/pages/info?x=1")).toBe("/pages/info");
    expect(normalizeRoute("http://localhost:3100/api/spaces/")).toBe("/spaces");
    expect(normalizeRoute("users/me")).toBe("/users/me");
    expect(normalizeRoute("docmore-app://abc123/api/pages/info?x=1")).toBe("/pages/info");
  });

  it("records reads", () => {
    for (const route of [
      "/users/me",
      "/spaces",
      "/spaces/info",
      "/pages/info",
      "/pages/sidebar-pages",
      "/pages/breadcrumbs",
      "/comments",
      "/favorites/ids",
      "/bases/rows",
      "/bases/info",
      "/workspace/members",
      "/notifications/unread-count",
    ]) {
      expect(isRecordable(route), route).toBe(true);
    }
  });

  it("never records writes, secrets or live-only answers", () => {
    for (const route of [
      "/pages/create",
      "/pages/update",
      "/pages/delete",
      "/pages/move",
      "/comments/create",
      "/bases/rows/create",
      "/bases/rows/update",
      "/auth/collab-token",
      "/auth/login",
      "/oauth/grants",
      "/api-keys",
      "/search",
      "/sync/pull",
      "/ai/chats",
      "/ai/chats/info",
      "/mfa/status",
      "/sessions",
      "/files/info",
    ]) {
      expect(isRecordable(route), route).toBe(false);
    }
  });

  it("keys a request by route and body", () => {
    expect(recordKey("/comments", { pageId: "p", limit: 100, cursor: undefined })).toBe(
      recordKey("/comments", { limit: 100, pageId: "p" }),
    );
    expect(recordKey("/comments", { pageId: "p" })).not.toBe(recordKey("/comments", { pageId: "q" }));
  });
});
