import { describe, it, expect, vi } from "vitest";

let throwOnNextCall = false;
vi.mock("fractional-indexing-jittered", () => ({
  generateJitteredKeyBetween: (a: string | null, b: string | null) => {
    if (throwOnNextCall) {
      throwOnNextCall = false;
      throw new Error("lower >= upper");
    }
    return `${a ?? "START"}|${b ?? "END"}`;
  },
}));

import { movedOptions, resolveCardDrop } from "../resolve-card-drop";
import { NO_VALUE_CHOICE_ID } from "@/features/base/types/base.types";

const mkRow = (id: string, position: string) =>
  ({ id, position, cells: {} }) as any;

describe("resolveCardDrop", () => {
  it("returns cells-only when cross-column drop happens with sort active", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "c1",
      targetColumnKey: "c2",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "b")],
      sortsActive: true,
    });
    expect(result.cells).toEqual({ "prop-status": "c2" });
    expect(result.position).toBeUndefined();
  });

  it("writes null cell value when target is the NO_VALUE column", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "c1",
      targetColumnKey: NO_VALUE_CHOICE_ID,
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "b")],
      sortsActive: false,
    });
    expect(result.cells).toEqual({ "prop-status": null });
  });

  it("returns position-only when intra-column drop with no sort", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "bottom",
      sourceColumnKey: "c1",
      targetColumnKey: "c1",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "a"), mkRow("r3", "c")],
      sortsActive: false,
    });
    expect(result.cells).toBeUndefined();
    expect(typeof result.position).toBe("string");
    // Between 'a' (r2) and 'c' (r3) → some key, exact value depends on jitter
    // but must satisfy 'a' < key < 'c' for typical jitter outputs.
    expect(result.position! > "a").toBe(true);
    expect(result.position! < "c").toBe(true);
  });

  it("returns both cells and position for cross-column with slot", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "c1",
      targetColumnKey: "c2",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "b"), mkRow("r3", "d")],
      sortsActive: false,
    });
    expect(result.cells).toEqual({ "prop-status": "c2" });
    expect(typeof result.position).toBe("string");
    expect(result.position! < "b").toBe(true);
  });

  it("appends to the end when targetCardId is not in columnRows (empty/below-last)", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "__column-body__", // sentinel
      edge: "bottom",
      sourceColumnKey: "c1",
      targetColumnKey: "c2",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r5", "z")],
      sortsActive: false,
    });
    expect(result.cells).toEqual({ "prop-status": "c2" });
    expect(result.position! > "z").toBe(true);
  });

  it("returns undefined for both fields when same column and sort active", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "c1",
      targetColumnKey: "c1",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "a")],
      sortsActive: true,
    });
    expect(result.cells).toBeUndefined();
    expect(result.position).toBeUndefined();
  });

  it("falls back to append-after-lower when generateJitteredKeyBetween throws", () => {
    throwOnNextCall = true;
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "c1",
      targetColumnKey: "c1",
      groupByPropertyId: "prop-status",
      columnRows: [mkRow("r2", "b"), mkRow("r3", "d")],
      sortsActive: false,
    });
    // First call (lower=null, upper="b") threw → second call (lower=null,
    // upper=null) succeeds. The mock returns "START|END" in that case.
    expect(result.cells).toBeUndefined();
    expect(result.position).toBe("START|END");
  });
});

describe("movedOptions", () => {
  it("swaps the option of the column left for the one landed on", () => {
    expect(movedOptions(["a", "c"], "a", "b")).toEqual(["b", "c"]);
    expect(movedOptions(["c", "a"], "a", "b")).toEqual(["c", "b"]);
  });

  it("does not repeat an option the card already had", () => {
    expect(movedOptions(["a", "b"], "a", "b")).toEqual(["b"]);
    expect(movedOptions(["b", "a"], "a", "b")).toEqual(["b"]);
  });

  it("gives the option to a card that had none", () => {
    expect(movedOptions([], NO_VALUE_CHOICE_ID, "b")).toEqual(["b"]);
    expect(movedOptions(undefined, NO_VALUE_CHOICE_ID, "b")).toEqual(["b"]);
  });

  it("takes every option away on No value", () => {
    expect(movedOptions(["a", "c"], "a", NO_VALUE_CHOICE_ID)).toEqual([]);
  });
});

describe("resolveCardDrop, on a board by a multi-select", () => {
  it("writes the list of options, not one option", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "a",
      targetColumnKey: "b",
      groupByPropertyId: "days",
      columnRows: [mkRow("r2", "b")],
      sortsActive: true,
      currentOptions: ["a", "c"],
    });
    expect(result.cells).toEqual({ days: ["b", "c"] });
  });

  it("leaves the cell alone within one column", () => {
    const result = resolveCardDrop({
      draggedCardId: "r1",
      targetCardId: "r2",
      edge: "top",
      sourceColumnKey: "a",
      targetColumnKey: "a",
      groupByPropertyId: "days",
      columnRows: [mkRow("r2", "b")],
      sortsActive: false,
      currentOptions: ["a"],
    });
    expect(result.cells).toBeUndefined();
    expect(result.position).toBeDefined();
  });
});
