import { Row } from "@tanstack/react-table";
import { IBaseProperty, IBaseRow } from "@/features/base/types/base.types";
import { partitionRowsByGroup } from "@/features/base/hooks/use-kanban-groups";

export type GridGroupBy = {
  property: IBaseProperty;
  subProperty?: IBaseProperty;
  hiddenChoiceIds?: string[];
  choiceOrder?: string[];
};

export type GridGroupHeaderItem = {
  kind: "header";
  key: string;
  depth: 0 | 1;
  name: string;
  color: string | null;
  count: number;
  collapsed: boolean;
  // cells a row added from this header starts with
  presetCells: Record<string, unknown>;
};
export type GridRowItem = { kind: "row"; row: Row<IBaseRow> };
export type GridItem = GridGroupHeaderItem | GridRowItem;

// Rows of a grouped table in display order: a header per group (and per
// sub-group with rows), then its rows unless the group is collapsed.
export function buildGridItems(
  rows: Row<IBaseRow>[],
  groupBy: GridGroupBy,
  collapsed: Set<string>,
  noValueLabel: string,
): GridItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { columns } = partitionRowsByGroup(
    rows.map((r) => r.original),
    groupBy.property,
    groupBy.hiddenChoiceIds,
    groupBy.choiceOrder,
  );
  const items: GridItem[] = [];
  const pushRows = (list: IBaseRow[]) => {
    for (const r of list) {
      const row = byId.get(r.id);
      if (row) items.push({ kind: "row", row });
    }
  };
  for (const col of columns) {
    const key = col.key;
    const isCollapsed = collapsed.has(key);
    const preset: Record<string, unknown> = col.choiceId ? { [groupBy.property.id]: col.choiceId } : {};
    items.push({
      kind: "header",
      key,
      depth: 0,
      name: col.choiceId ? col.name : noValueLabel,
      color: col.color,
      count: col.rows.length,
      collapsed: isCollapsed,
      presetCells: preset,
    });
    if (isCollapsed) continue;
    if (groupBy.subProperty) {
      const sub = partitionRowsByGroup(col.rows, groupBy.subProperty, undefined, undefined);
      for (const s of sub.columns) {
        if (s.rows.length === 0) continue;
        const subKey = `${key}/${s.key}`;
        const subCollapsed = collapsed.has(subKey);
        items.push({
          kind: "header",
          key: subKey,
          depth: 1,
          name: s.choiceId ? s.name : noValueLabel,
          color: s.color,
          count: s.rows.length,
          collapsed: subCollapsed,
          presetCells: { ...preset, ...(s.choiceId ? { [groupBy.subProperty.id]: s.choiceId } : {}) },
        });
        if (!subCollapsed) pushRows(s.rows);
      }
    } else {
      pushRows(col.rows);
    }
  }
  return items;
}
