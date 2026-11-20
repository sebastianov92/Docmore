import { Table } from "@tanstack/react-table";
import {
  IBase,
  IBaseRow,
  IBaseView,
} from "@/features/base/types/base.types";
import { BaseTable } from "@/features/base/components/base-table";
import { BaseKanban } from "@/features/base/components/views/kanban/base-kanban";
import { BaseCalendar } from "@/features/base/components/views/calendar/base-calendar";
import { BaseList } from "@/features/base/components/views/list/base-list";
import { BaseGallery } from "@/features/base/components/views/gallery/base-gallery";
import { BaseFeed } from "@/features/base/components/views/feed/base-feed";
import { BaseTimeline } from "@/features/base/components/views/timeline/base-timeline";
import { BaseChart } from "@/features/base/components/views/chart/base-chart";

type ViewRendererProps = {
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
  onColumnReorder: (columnId: string, finishIndex: number) => void;
  onResizeEnd: () => void;
  onRowReorder: (
    rowId: string,
    targetRowId: string,
    dropPosition: "above" | "below",
  ) => void;
  onCardClick: (rowId: string) => void;
  persistViewConfig: () => void;
  scrollportEl: HTMLDivElement | null;
  stickyBandPrelude?: React.ReactNode;
  editable?: boolean;
  // false while the base is locked: no new properties.
  canEditStructure?: boolean;
  // Adds a row that starts with these cells (group headings).
  onAddRowWithCells?: (cells: Record<string, unknown>) => void;
};

export function ViewRenderer(props: ViewRendererProps) {
  const viewType = props.effectiveView?.type ?? "table";

  if (viewType === "calendar") {
    return (
      <BaseCalendar
        base={props.base}
        effectiveView={props.effectiveView}
        editable={Boolean(props.editable)}
        onCardClick={props.onCardClick}
      />
    );
  }

  if (viewType === "chart") {
    return (
      <BaseChart
        base={props.base}
        effectiveView={props.effectiveView}
        embedded={props.embedded}
        editable={Boolean(props.editable)}
      />
    );
  }

  if (viewType === "timeline") {
    return (
      <BaseTimeline
        base={props.base}
        effectiveView={props.effectiveView}
        embedded={props.embedded}
        editable={Boolean(props.editable)}
        onCardClick={props.onCardClick}
      />
    );
  }

  if (viewType === "list") {
    return (
      <BaseList
        base={props.base}
        rows={props.rows}
        effectiveView={props.effectiveView}
        embedded={props.embedded}
        onCardClick={props.onCardClick}
        onAddRow={props.onAddRow}
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onFetchNextPage={props.onFetchNextPage}
      />
    );
  }

  if (viewType === "feed") {
    return (
      <BaseFeed
        base={props.base}
        rows={props.rows}
        effectiveView={props.effectiveView}
        embedded={props.embedded}
        onCardClick={props.onCardClick}
        onAddRow={props.onAddRow}
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onFetchNextPage={props.onFetchNextPage}
      />
    );
  }

  if (viewType === "gallery") {
    return (
      <BaseGallery
        base={props.base}
        rows={props.rows}
        effectiveView={props.effectiveView}
        embedded={props.embedded}
        onCardClick={props.onCardClick}
        onAddRow={props.onAddRow}
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onFetchNextPage={props.onFetchNextPage}
      />
    );
  }

  if (viewType === "kanban") {
    return (
      <BaseKanban
        base={props.base}
        rows={props.rows}
        effectiveView={props.effectiveView}
        onCardClick={props.onCardClick}
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onFetchNextPage={props.onFetchNextPage}
      />
    );
  }

  return <BaseTable {...props} />;
}
