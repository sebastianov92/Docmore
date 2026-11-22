import { describe, expect, it } from "vitest";
import { planSystemSearch, type SearchRow, type SearchSpace } from "./system-search";

const spaces: SearchSpace[] = [
  { id: "s1", slug: "general", name: "General" },
  { id: "s2", slug: null, name: "No address yet" },
];
const row = (id: string, title: string | null, extra: Partial<SearchRow> = {}): SearchRow => ({
  id,
  slugId: `slug-${id}`,
  title,
  spaceId: "s1",
  ...extra,
});

describe("system search plan", () => {
  it("indexes every page of the tree by title, with its space", () => {
    const plan = planSystemSearch([row("a", "Roadmap"), row("b", null), row("c", "  ")], spaces, {}, () => false);
    expect(plan.index.map((item) => [item.id, item.title, item.detail, item.withText])).toEqual([
      ["a", "Roadmap", "General", false],
      ["b", "Untitled", "General", false],
      ["c", "Untitled", "General", false],
    ]);
    expect(plan.index[0].path).toContain("/s/general/p/");
    expect(plan.index[0].path).toContain("slug-a");
    expect(plan.remove).toEqual([]);
    expect(Object.keys(plan.sent)).toEqual(["a", "b", "c"]);
  });

  it("sends nothing again when nothing changed", () => {
    const first = planSystemSearch([row("a", "Roadmap")], spaces, {}, () => false);
    const second = planSystemSearch([row("a", "Roadmap")], spaces, first.sent, () => false);
    expect(second.index).toEqual([]);
    expect(second.remove).toEqual([]);
  });

  it("sends a page again when its title, its address or its space name changes", () => {
    const first = planSystemSearch([row("a", "Roadmap")], spaces, {}, () => false);
    expect(planSystemSearch([row("a", "Roadmap 2027")], spaces, first.sent, () => false).index).toHaveLength(1);
    expect(planSystemSearch([row("a", "Roadmap", { slugId: "other" })], spaces, first.sent, () => false).index).toHaveLength(1);
    const renamed = [{ id: "s1", slug: "general", name: "Company" }];
    expect(planSystemSearch([row("a", "Roadmap")], renamed, first.sent, () => false).index[0].detail).toBe("Company");
  });

  it("removes what left the tree and skips what has no address", () => {
    const first = planSystemSearch([row("a", "A"), row("b", "B")], spaces, {}, () => false);
    const plan = planSystemSearch(
      [row("a", "A"), row("new", "Draft", { localOnly: true }), row("x", "Elsewhere", { spaceId: "s2" }), row("y", "Lost", { spaceId: "gone" })],
      spaces,
      first.sent,
      () => false,
    );
    expect(plan.index).toEqual([]);
    expect(plan.remove).toEqual(["b"]);
    expect(Object.keys(plan.sent)).toEqual(["a"]);
  });

  it("indexes with text once a page is on the device and again when its text changes", () => {
    const titles = planSystemSearch([row("a", "A")], spaces, {}, () => false);
    const downloaded = planSystemSearch([row("a", "A")], spaces, titles.sent, () => true);
    expect(downloaded.index.map((item) => [item.id, item.withText])).toEqual([["a", true]]);
    expect(planSystemSearch([row("a", "A")], spaces, downloaded.sent, () => true).index).toEqual([]);
    expect(planSystemSearch([row("a", "A")], spaces, downloaded.sent, () => true, new Set(["a"])).index).toHaveLength(1);
    // the text of a page that is not on the device is not there to send
    expect(planSystemSearch([row("a", "A")], spaces, titles.sent, () => false, new Set(["a"])).index).toEqual([]);
    // off the device again: found by title alone
    const dropped = planSystemSearch([row("a", "A")], spaces, downloaded.sent, () => false);
    expect(dropped.index.map((item) => [item.id, item.withText])).toEqual([["a", false]]);
  });
});
