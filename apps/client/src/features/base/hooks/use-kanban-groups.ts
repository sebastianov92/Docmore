import { useMemo } from "react";
import {
  IBaseProperty,
  IBaseRow,
  NO_VALUE_CHOICE_ID,
  SelectTypeOptions,
} from "@/features/base/types/base.types";

// What a board can be grouped by. A multi-select groups too: a card with
// several options shows under each of them.
export const KANBAN_GROUP_TYPES: readonly string[] = [
  "select",
  "status",
  "multiSelect",
];

export function isKanbanGroupable(
  property: Pick<IBaseProperty, "type"> | undefined,
): boolean {
  return Boolean(property && KANBAN_GROUP_TYPES.includes(property.type));
}

export type KanbanColumnData = {
  key: string;            // choice id or NO_VALUE_CHOICE_ID
  choiceId: string | null; // null for NO_VALUE column
  name: string;
  color: string | null;
  rows: IBaseRow[];
};

export type PartitionResult = {
  columns: KanbanColumnData[];
  groupByPropertyId: string | null;
};

function readChoiceOptions(property: IBaseProperty | undefined): {
  ids: string[];
  byId: Map<string, { id: string; name: string; color: string }>;
} {
  if (!property) return { ids: [], byId: new Map() };
  const opts = (property.typeOptions ?? {}) as Partial<SelectTypeOptions>;
  const choices = opts.choices ?? [];
  const order = (opts.choiceOrder ?? []).filter((id) =>
    choices.some((c) => c.id === id),
  );
  // Any choice not in order: append in choices-array order.
  const ordered = [
    ...order,
    ...choices.filter((c) => !order.includes(c.id)).map((c) => c.id),
  ];
  const byId = new Map<string, { id: string; name: string; color: string }>(
    choices.map((c) => [c.id, c]),
  );
  return { ids: ordered, byId };
}

export function partitionRowsByGroup(
  rows: IBaseRow[],
  property: IBaseProperty | undefined,
  hiddenChoiceIds: string[] | undefined,
  choiceOrderOverride: string[] | undefined,
): PartitionResult {
  if (!property) return { columns: [], groupByPropertyId: null };
  const { ids: propertyChoiceIds, byId } = readChoiceOptions(property);

  // Resolve column key order.
  let order: string[];
  if (choiceOrderOverride && choiceOrderOverride.length > 0) {
    const valid = new Set<string>([...propertyChoiceIds, NO_VALUE_CHOICE_ID]);
    const fromOverride = choiceOrderOverride.filter((id) => valid.has(id));
    const overrideSet = new Set(fromOverride);
    // Always include NO_VALUE somewhere (sentinel for rows with no
    // grouping value). If the user listed it in the override, respect
    // that position; otherwise append it after the override entries.
    const noValueTail = overrideSet.has(NO_VALUE_CHOICE_ID)
      ? []
      : [NO_VALUE_CHOICE_ID];
    // Append any property choices the user hasn't placed yet (new
    // choices added to the property after this view was saved).
    const missingChoices = propertyChoiceIds.filter(
      (id) => !overrideSet.has(id),
    );
    order = [...fromOverride, ...noValueTail, ...missingChoices];
  } else {
    order = [NO_VALUE_CHOICE_ID, ...propertyChoiceIds];
  }
  const hidden = new Set(hiddenChoiceIds ?? []);
  order = order.filter((id) => !hidden.has(id));

  // Build empty buckets first so empty columns still render.
  const buckets = new Map<string, IBaseRow[]>();
  for (const key of order) buckets.set(key, []);

  const many = property.type === "multiSelect";
  for (const row of rows) {
    const value = (row.cells ?? {})[property.id];
    if (many) {
      const options = Array.isArray(value)
        ? [...new Set(value.filter((v) => typeof v === "string" && byId.has(v)))]
        : [];
      if (options.length === 0) {
        buckets.get(NO_VALUE_CHOICE_ID)?.push(row);
        continue;
      }
      // under each option that has a column; a hidden one keeps it out
      for (const id of options) buckets.get(id as string)?.push(row);
      continue;
    }
    const key =
      typeof value === "string" && buckets.has(value)
        ? value
        : NO_VALUE_CHOICE_ID;
    if (!buckets.has(key)) continue; // hidden
    buckets.get(key)!.push(row);
  }

  const columns: KanbanColumnData[] = order.map((key) => {
    if (key === NO_VALUE_CHOICE_ID) {
      return {
        key,
        choiceId: null,
        name: "No value",
        color: null,
        rows: buckets.get(key) ?? [],
      };
    }
    const c = byId.get(key);
    return {
      key,
      choiceId: key,
      name: c?.name ?? "",
      color: c?.color ?? null,
      rows: buckets.get(key) ?? [],
    };
  });

  return { columns, groupByPropertyId: property.id };
}

export function useKanbanGroups(
  rows: IBaseRow[],
  property: IBaseProperty | undefined,
  hiddenChoiceIds: string[] | undefined,
  choiceOrderOverride: string[] | undefined,
): PartitionResult {
  return useMemo(
    () =>
      partitionRowsByGroup(
        rows,
        property,
        hiddenChoiceIds,
        choiceOrderOverride,
      ),
    [rows, property, hiddenChoiceIds, choiceOrderOverride],
  );
}
