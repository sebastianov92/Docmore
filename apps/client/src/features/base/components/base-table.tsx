import { GridContainer } from "@/features/base/components/grid/grid-container";
import { Table } from "@tanstack/react-table";
import {
  IBase,
  IBaseRow,
  IBaseView,
} from "@/features/base/types/base.types";
import { useMemo } from "react";
import { GridGroupBy } from "@/features/base/components/grid/grid-groups";

type BaseTableProps = {
  base: IBase;
  rows: IBaseRow[];
  effectiveView: IBaseView | undefined;
  table: Table<IBaseRow>;
  pageId: string;
  embedded?: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNextPage: () => void;
  onCellUpdate: (rowId: string, propertyId: string, value: unknown) => void;
  onAddRow?: () => void;
  editable?: boolean;
  canEditStructure?: boolean;
  onColumnReorder: (columnId: string, finishIndex: number) => void;
  onResizeEnd: () => void;
  onRowReorder: (
    rowId: string,
    targetRowId: string,
    dropPosition: "above" | "below",
  ) => void;
  persistViewConfig: () => void;
  scrollportEl: HTMLDivElement | null;
  stickyBandPrelude?: React.ReactNode;
  onAddRowWithCells?: (cells: Record<string, unknown>) => void;
};

export function BaseTable({
  base,
  rows: _rows,
  effectiveView,
  table,
  pageId,
  embedded,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
  onCellUpdate,
  onAddRow,
  editable,
  canEditStructure,
  onColumnReorder,
  onResizeEnd,
  onRowReorder,
  scrollportEl,
  stickyBandPrelude,
  onAddRowWithCells,
}: BaseTableProps) {
  // Grouping by a select/status property, with an optional second level.
  const groupBy = useMemo<GridGroupBy | undefined>(() => {
    const cfg = effectiveView?.config;
    if (!cfg?.groupByPropertyId) return undefined;
    const groupable = (p: { type: string }) => p.type === "select" || p.type === "status";
    const property = base.properties.find((p) => p.id === cfg.groupByPropertyId && groupable(p));
    if (!property) return undefined;
    const subProperty = base.properties.find(
      (p) => p.id === cfg.subGroupByPropertyId && p.id !== property.id && groupable(p),
    );
    return { property, subProperty, hiddenChoiceIds: cfg.hiddenChoiceIds, choiceOrder: cfg.choiceOrder };
  }, [base.properties, effectiveView?.config]);
  return (
    <GridContainer
      table={table}
      properties={base.properties}
      onCellUpdate={onCellUpdate}
      onAddRow={onAddRow}
      canAddProperty={editable !== false && canEditStructure !== false}
      pageId={pageId}
      onColumnReorder={onColumnReorder}
      onResizeEnd={onResizeEnd}
      onRowReorder={onRowReorder}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onFetchNextPage={onFetchNextPage}
      scrollElement={embedded ? window : scrollportEl}
      stickyBandPrelude={stickyBandPrelude ?? null}
      groupBy={groupBy}
      onAddRowWithCells={onAddRowWithCells}
    />
  );
}
