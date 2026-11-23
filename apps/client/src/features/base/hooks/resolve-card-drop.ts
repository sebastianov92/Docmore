import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import { IBaseRow, NO_VALUE_CHOICE_ID } from "@/features/base/types/base.types";

type Edge = "top" | "bottom";

export type ResolveCardDropInput = {
  draggedCardId: string;
  targetCardId: string;
  edge: Edge | null;
  sourceColumnKey: string;
  targetColumnKey: string;
  groupByPropertyId: string;
  columnRows: IBaseRow[]; // rows currently in the target column, in display order
  sortsActive: boolean;
  // Board grouped by a multi-select: the options the dragged card has now.
  // Left out (undefined) for a select or a status, whose cell is one option.
  currentOptions?: unknown;
};

export type ResolveCardDropResult = {
  cells: Record<string, unknown> | undefined;
  position: string | undefined;
};

// A card of a multi-select board sits under each of its options. Moving it
// swaps the option of the column it left for the one it lands on, where the
// old one was, and keeps the others. Onto "No value" it loses them all:
// short of that it would not show there.
export function movedOptions(
  current: unknown,
  from: string,
  to: string,
): string[] {
  const now = Array.isArray(current)
    ? current.filter((v): v is string => typeof v === "string")
    : [];
  if (to === NO_VALUE_CHOICE_ID) return [];
  const out: string[] = [];
  let placed = false;
  for (const id of now) {
    if (id === to) {
      if (!placed) out.push(to);
      placed = true;
    } else if (id === from) {
      if (!placed && !now.includes(to)) {
        out.push(to);
        placed = true;
      }
    } else out.push(id);
  }
  if (!placed) out.push(to);
  return out;
}

export function resolveCardDrop(
  input: ResolveCardDropInput,
): ResolveCardDropResult {
  const {
    draggedCardId,
    targetCardId,
    edge,
    sourceColumnKey,
    targetColumnKey,
    groupByPropertyId,
    columnRows,
    sortsActive,
    currentOptions,
  } = input;

  const sameColumn = sourceColumnKey === targetColumnKey;

  // Compute the cells patch first.
  const cells = sameColumn
    ? undefined
    : {
        [groupByPropertyId]:
          currentOptions !== undefined
            ? movedOptions(currentOptions, sourceColumnKey, targetColumnKey)
            : targetColumnKey === NO_VALUE_CHOICE_ID
              ? null
              : targetColumnKey,
      };

  // Same column + sort active → block (caller should have stopped the drag
  // via canDrop, but we return no-op for safety).
  if (sameColumn && sortsActive) {
    return { cells: undefined, position: undefined };
  }

  // Sort active and cross-column → only cells, no position.
  if (sortsActive) {
    return { cells, position: undefined };
  }

  // Sort inactive → compute the slot.
  // Filter the dragged card out of the column (it may already be there
  // when intra-column drag).
  const target = columnRows.filter((r) => r.id !== draggedCardId);
  const targetIndex = target.findIndex((r) => r.id === targetCardId);

  let lower: string | null;
  let upper: string | null;

  if (targetIndex === -1) {
    // Drop on column body / sentinel / below-last → append.
    const last = target[target.length - 1];
    lower = last?.position ?? null;
    upper = null;
  } else if (edge === "top") {
    lower = target[targetIndex - 1]?.position ?? null;
    upper = target[targetIndex].position;
  } else {
    lower = target[targetIndex].position;
    upper = target[targetIndex + 1]?.position ?? null;
  }

  let position: string;
  try {
    position = generateJitteredKeyBetween(lower, upper);
  } catch {
    // Throws whenever `lower >= upper` (the row ordering in `columnRows`
    // briefly diverged from position ordering — typically during a
    // concurrent reorder). Fall back to insert-after-lower. The card lands
    // at the end of the column rather than at the dropped slot; surprising
    // but better than rejecting the drop. The reconciliation arrives via
    // the realtime patch.
    position = generateJitteredKeyBetween(lower, null);
  }
  return { cells, position };
}
