import { describe, it, expect } from "vitest";
import {
  isKanbanGroupable,
  partitionRowsByGroup,
} from "../use-kanban-groups";
import { NO_VALUE_CHOICE_ID } from "@/features/base/types/base.types";

describe("partitionRowsByGroup", () => {
  const property = {
    id: "p1",
    type: "status",
    typeOptions: {
      choices: [
        { id: "c1", name: "Todo", color: "blue" },
        { id: "c2", name: "Done", color: "green" },
      ],
      choiceOrder: ["c1", "c2"],
    },
  } as any;

  const rows = [
    { id: "r1", cells: { p1: "c1" }, position: "a0" },
    { id: "r2", cells: { p1: "c2" }, position: "a1" },
    { id: "r3", cells: {}, position: "a2" },
    { id: "r4", cells: { p1: "c1" }, position: "a3" },
  ] as any;

  it("groups rows under the choice id their cell points at", () => {
    const result = partitionRowsByGroup(rows, property, undefined, undefined);
    expect(result.columns.map((c) => c.key)).toEqual([
      NO_VALUE_CHOICE_ID,
      "c1",
      "c2",
    ]);
    expect(result.columns[1].rows.map((r) => r.id)).toEqual(["r1", "r4"]);
    expect(result.columns[2].rows.map((r) => r.id)).toEqual(["r2"]);
  });

  it("puts rows without the cell into the NO_VALUE column", () => {
    const result = partitionRowsByGroup(rows, property, undefined, undefined);
    expect(result.columns[0].key).toBe(NO_VALUE_CHOICE_ID);
    expect(result.columns[0].rows.map((r) => r.id)).toEqual(["r3"]);
  });

  it("hides columns listed in hiddenChoiceIds", () => {
    const result = partitionRowsByGroup(rows, property, ["c2"], undefined);
    expect(result.columns.map((c) => c.key)).toEqual([NO_VALUE_CHOICE_ID, "c1"]);
  });

  it("hides the NO_VALUE column when hiddenChoiceIds includes the sentinel", () => {
    const result = partitionRowsByGroup(
      rows,
      property,
      [NO_VALUE_CHOICE_ID],
      undefined,
    );
    expect(result.columns.map((c) => c.key)).toEqual(["c1", "c2"]);
  });

  it("respects an override choiceOrder", () => {
    const result = partitionRowsByGroup(
      rows,
      property,
      undefined,
      ["c2", "c1", NO_VALUE_CHOICE_ID],
    );
    expect(result.columns.map((c) => c.key)).toEqual([
      "c2",
      "c1",
      NO_VALUE_CHOICE_ID,
    ]);
  });

  it("appends newly-added choices (missing from override choiceOrder) at the end", () => {
    const result = partitionRowsByGroup(
      rows,
      property,
      undefined,
      ["c1"], // missing c2 and NO_VALUE
    );
    expect(result.columns.map((c) => c.key)).toEqual([
      "c1",
      NO_VALUE_CHOICE_ID,
      "c2",
    ]);
  });

  it("drops entries in choiceOrder that no longer exist on the property", () => {
    const result = partitionRowsByGroup(
      rows,
      property,
      undefined,
      ["c1", "deleted-choice", "c2"],
    );
    // 'deleted-choice' is filtered out as stale. NO_VALUE is auto-appended
    // (it's never in the property's choices but always rendered unless
    // explicitly hidden via hiddenChoiceIds).
    expect(result.columns.map((c) => c.key)).toEqual([
      "c1",
      "c2",
      NO_VALUE_CHOICE_ID,
    ]);
  });

  it("returns null columns when groupByPropertyId is unset", () => {
    const result = partitionRowsByGroup(rows, undefined, undefined, undefined);
    expect(result.columns).toEqual([]);
  });

  it("preserves row order within a column (input order)", () => {
    const rowsOutOfOrder = [
      { id: "r1", cells: { p1: "c1" }, position: "b" },
      { id: "r2", cells: { p1: "c1" }, position: "a" },
    ] as any;
    const result = partitionRowsByGroup(
      rowsOutOfOrder,
      property,
      undefined,
      undefined,
    );
    expect(result.columns[1].rows.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("partitionRowsByGroup, by a multi-select", () => {
  const property = {
    id: "p1",
    type: "multiSelect",
    typeOptions: {
      choices: [
        { id: "d1", name: "Day 1", color: "green" },
        { id: "d2", name: "Day 2", color: "blue" },
        { id: "d3", name: "Day 3", color: "yellow" },
      ],
    },
  } as any;

  const rows = [
    { id: "r1", cells: { p1: ["d1"] }, position: "a0" },
    { id: "r2", cells: { p1: ["d1", "d2"] }, position: "a1" },
    { id: "r3", cells: { p1: [] }, position: "a2" },
    { id: "r4", cells: {}, position: "a3" },
    { id: "r5", cells: { p1: ["gone"] }, position: "a4" },
    { id: "r6", cells: { p1: ["d2", "d2"] }, position: "a5" },
  ] as any;

  it("shows a card under each of its options", () => {
    const { columns } = partitionRowsByGroup(rows, property, undefined, undefined);
    const of = (key: string) =>
      columns.find((c) => c.key === key)!.rows.map((r) => r.id);
    expect(of("d1")).toEqual(["r1", "r2"]);
    expect(of("d2")).toEqual(["r2", "r6"]);
    expect(of("d3")).toEqual([]);
  });

  it("keeps rows with no option, or only options that are gone, under No value", () => {
    const { columns } = partitionRowsByGroup(rows, property, undefined, undefined);
    expect(columns[0].key).toBe(NO_VALUE_CHOICE_ID);
    expect(columns[0].rows.map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
  });

  it("leaves a card out of a hidden column and in its other ones", () => {
    const { columns } = partitionRowsByGroup(rows, property, ["d1"], undefined);
    expect(columns.map((c) => c.key)).toEqual([NO_VALUE_CHOICE_ID, "d2", "d3"]);
    expect(columns[1].rows.map((r) => r.id)).toEqual(["r2", "r6"]);
    // r1 only had the hidden option: it is not moved under No value
    expect(columns[0].rows.map((r) => r.id)).toEqual(["r3", "r4", "r5"]);
  });

  it("says which kinds of property can group a board", () => {
    expect(isKanbanGroupable({ type: "select" } as any)).toBe(true);
    expect(isKanbanGroupable({ type: "status" } as any)).toBe(true);
    expect(isKanbanGroupable({ type: "multiSelect" } as any)).toBe(true);
    expect(isKanbanGroupable({ type: "text" } as any)).toBe(false);
    expect(isKanbanGroupable(undefined)).toBe(false);
  });
});
