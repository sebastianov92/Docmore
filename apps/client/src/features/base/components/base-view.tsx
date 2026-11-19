import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { Text, Stack } from "@mantine/core";
import { useAtom } from "jotai";
import { IconDatabase } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { reorder } from "@atlaskit/pragmatic-drag-and-drop/reorder";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import {
  useBaseQuery,
  useUpdateBaseMutation,
} from "@/features/base/queries/base-query";
import { useBaseSocket } from "@/features/base/hooks/use-base-socket";
import {
  FilterGroup,
  ViewSortConfig,
  BaseViewType,
  IBaseRow,
} from "@/features/base/types/base.types";
import {
  useBaseRowsQuery,
  useBaseRowsCountQuery,
  flattenRows,
  useCreateRowMutation,
  useUpdateRowMutation,
  useReorderRowMutation,
  useBaseTemplatesQuery,
} from "@/features/base/queries/base-row-query";
import {
  useCreateViewMutation,
  useUpdateViewMutation,
} from "@/features/base/queries/base-view-query";
import { activeViewIdAtomFamily } from "@/features/base/atoms/base-atoms";
import { useBaseTable } from "@/features/base/hooks/use-base-table";
import { useRowSelection } from "@/features/base/hooks/use-row-selection";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useViewDraft } from "@/features/base/hooks/use-view-draft";
import { useSpaceQuery } from "@/features/space/queries/space-query";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type";
import { BaseToolbar } from "@/features/base/components/base-toolbar";
import { BaseViewDraftBanner } from "@/features/base/components/base-view-draft-banner";
import { BaseTableSkeleton } from "@/features/base/components/base-table-skeleton";
import { ViewRenderer } from "@/features/base/components/views/view-renderer";
import { useRowDetailModal } from "@/features/base/hooks/use-row-detail-modal";
import { RowDetailModal } from "@/features/base/components/row-detail-modal/row-detail-modal";
import classes from "@/features/base/styles/grid.module.css";

type BaseViewProps = {
  pageId: string;
  embedded?: boolean;
  // Decided by the host (page permissions and the feature flag); when it is
  // not given the base's own permissions decide.
  editable?: boolean;
  // Rendered above the toolbar on the standalone page (the page title).
  titleSlot?: ReactNode;
  // An embed shows this view, apart from the base page's own choice;
  // switching tabs in it reports the new view (the embed remembers it).
  fixedViewId?: string | null;
  onFixedViewChange?: (viewId: string) => void;
};

export function BaseView({
  pageId,
  embedded,
  editable,
  titleSlot,
  fixedViewId,
  onFixedViewChange,
}: BaseViewProps) {
  const { t } = useTranslation();
  // Subscribe to the base's realtime room so other clients' edits,
  // schema changes, and async-job completions reconcile into our cache.
  useBaseSocket(pageId);
  const { data: base, isLoading: baseLoading, error: baseError } =
    useBaseQuery(pageId);

  const [sharedViewId, setSharedViewId] = useAtom(
    activeViewIdAtomFamily(pageId),
  ) as unknown as [string | null, (val: string | null) => void];
  // Embeds keep their own view so two embeds of one base can differ.
  const isFixed = fixedViewId !== undefined;
  const [localViewId, setLocalViewId] = useState<string | null>(fixedViewId ?? null);
  const activeViewId = isFixed ? localViewId : sharedViewId;
  const setActiveViewId = useCallback(
    (id: string | null) => (isFixed ? setLocalViewId(id) : setSharedViewId(id)),
    [isFixed, setSharedViewId],
  );

  const views = base?.views ?? [];
  const activeView = useMemo(() => {
    if (!views.length) return undefined;
    return views.find((v) => v.id === activeViewId) ?? views[0];
  }, [views, activeViewId]);

  const { data: currentUser } = useCurrentUser();
  const {
    effectiveFilter,
    effectiveSorts,
    isDirty,
    setFilter: setDraftFilter,
    setSorts: setDraftSorts,
    reset: resetDraft,
    buildPromotedConfig,
  } = useViewDraft({
    userId: currentUser?.user.id,
    pageId,
    viewId: activeView?.id,
    baselineFilter: activeView?.config?.filter,
    baselineSorts: activeView?.config?.sorts,
  });

  // Render view: baseline merged with any local draft. Passed to
  // `useBaseTable` (for table state seeding) and to the toolbar (for badge
  // counts). The real `activeView` is still used as the auto-persist
  // baseline so drafts can't leak into column-layout writes.
  const effectiveView = useMemo(
    () =>
      activeView
        ? {
            ...activeView,
            config: {
              ...activeView.config,
              filter: effectiveFilter,
              sorts: effectiveSorts,
            },
          }
        : undefined,
    [activeView, effectiveFilter, effectiveSorts],
  );

  // Effective values drive the row query and the client-side position
  // sort guard below. The old `activeView.config` reads are no longer the
  // source of truth once drafts are involved.
  const activeFilter = effectiveFilter;
  const activeSorts = effectiveSorts;

  // `useSpaceQuery` is guarded by `enabled: !!spaceId` internally, so
  // passing `""` when `base` hasn't loaded yet is safe. See
  // use-history-restore.tsx for the same pattern.
  const { data: space } = useSpaceQuery(base?.spaceId ?? "");
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  // Bases are pages — gate save on the same Page subject the rest of
  // the app uses; the dedicated Base subject was redundant.
  const canSave =
    editable ??
    base?.permissions?.canEdit ??
    spaceAbility.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page);
  // A locked base keeps its properties and views; rows still change.
  const structureEditable = canSave && !base?.baseLocked;
  const { data: templatesData } = useBaseTemplatesQuery(canSave ? pageId : undefined);
  const templates = templatesData?.items;
  const updateBaseMutation = useUpdateBaseMutation();

  // Hold the rows query until `base` has loaded. Otherwise the query
  // fires once with `activeFilter` / `activeSorts` still undefined
  // (a "bland" list request), then fires a second time as soon as the
  // active view's config resolves — doubling network traffic on every
  // base open for any view that has sort or filter.
  const {
    data: rowsData,
    isLoading: rowsLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBaseRowsQuery(base ? pageId : undefined, activeFilter, activeSorts);

  // Fire the count request alongside the rows query. Not rendered yet —
  // this mounts the query so its cache is warm for when the toolbar
  // consumes it. Gate on `currentUser` too so `useViewDraft` has had a
  // chance to hydrate the persisted draft from localStorage; otherwise
  // the first post-refresh count would race ahead of the user's saved
  // filter and fire with baseline-only (or nothing).
  const canFetchCount = !!base && !!currentUser;
  useBaseRowsCountQuery(canFetchCount ? pageId : undefined, activeFilter);

  const updateRowMutation = useUpdateRowMutation();
  const createRowMutation = useCreateRowMutation();
  const reorderRowMutation = useReorderRowMutation();
  const createViewMutation = useCreateViewMutation();
  const updateViewMutation = useUpdateViewMutation();

  useEffect(() => {
    if (activeView && activeViewId !== activeView.id) {
      setActiveViewId(activeView.id);
    }
  }, [activeView, activeViewId, setActiveViewId]);

  const { clear: clearSelection } = useRowSelection(pageId);
  useEffect(() => {
    clearSelection();
  }, [pageId, activeView?.id, clearSelection]);

  // Track the scrollport element in state (not a ref) so the virtualizer's
  // `_willUpdate` re-runs when the div attaches on first mount. Reading
  // `scrollportRef.current` during render would always be null on the
  // render that mounts the div, and no subsequent render is guaranteed —
  // particularly after a filter change, where the scrollport remounts via
  // the `rowsLoading` skeleton path. The virtualizer would then sit on
  // `scrollElement=null`, render zero items, and only recover when
  // something else forced a re-render (e.g. switching views).
  const [scrollportEl, setScrollportEl] = useState<HTMLDivElement | null>(null);

  const rows = useMemo(() => {
    const flat = flattenRows(rowsData);
    // When a sort is active, the server returns rows in the requested
    // sort order via keyset pagination. Re-sorting by `position` on the
    // client would override that with fractional-index order — visibly
    // breaking the sort as more pages load. Only apply the position
    // sort when no view sort is active (where it keeps
    // optimistically-created and ws-pushed rows in place without a
    // refetch).
    const ordered =
      activeSorts && activeSorts.length > 0
        ? flat
        : flat.sort((a, b) =>
            a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
          );
    // Sub-items: children follow their parent, indented by depth.
    if (effectiveView?.config?.subItems === false) return ordered;
    return nestSubItems(ordered);
  }, [rowsData, activeSorts, effectiveView?.config?.subItems]);

  const { table, persistViewConfig } = useBaseTable(base, rows, effectiveView, {
    baselineConfig: activeView?.config,
  });

  const isKanban = effectiveView?.type === "kanban";
  const isCalendar = effectiveView?.type === "calendar";
  const isCardView =
    isKanban ||
    isCalendar ||
    effectiveView?.type === "list" ||
    effectiveView?.type === "gallery" ||
    effectiveView?.type === "timeline" ||
    effectiveView?.type === "chart";

  const handleCellUpdate = useCallback(
    (rowId: string, propertyId: string, value: unknown) => {
      updateRowMutation.mutate({
        rowId,
        pageId,
        cells: { [propertyId]: value },
      });
    },
    [pageId, updateRowMutation],
  );

  const handleAddRow = useCallback(() => {
    createRowMutation.mutate({ pageId });
  }, [pageId, createRowMutation]);

  const handleAddRowWithCells = useCallback(
    (cells: Record<string, unknown>) => {
      createRowMutation.mutate({ pageId, cells });
    },
    [pageId, createRowMutation],
  );

  const handleToggleLock = useCallback(() => {
    updateBaseMutation.mutate({ pageId, locked: !base?.baseLocked });
  }, [pageId, base?.baseLocked, updateBaseMutation]);

  const handleViewChange = useCallback(
    (viewId: string) => {
      setActiveViewId(viewId);
      if (isFixed) onFixedViewChange?.(viewId);
    },
    [setActiveViewId, isFixed, onFixedViewChange],
  );

  // A link to the base may name the view to open (?view=<id>).
  const hasViews = views.length > 0;
  useEffect(() => {
    if (embedded || isFixed || !hasViews) return;
    const wanted = new URLSearchParams(window.location.search).get("view");
    if (wanted && views.some((v) => v.id === wanted)) setSharedViewId(wanted);
    // only once the views are known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasViews]);

  const handleAddView = useCallback(
    (type: BaseViewType = "table") => {
      const names: Record<BaseViewType, string> = {
        table: t("Table"),
        kanban: t("Kanban"),
        calendar: t("Calendar"),
        list: t("List"),
        gallery: t("Gallery"),
        timeline: t("Timeline"),
        chart: t("Chart"),
      };
      const config: Record<string, unknown> = {};
      if (type === "chart") {
        const x =
          base?.properties.find((p) => p.type === "select" || p.type === "status") ??
          base?.properties.find((p) => p.type === "date");
        if (x) config.chartXPropertyId = x.id;
        config.chartType = "bar";
        config.chartShowValues = true;
      }
      if (type === "timeline") {
        const dates = base?.properties.filter((p) => p.type === "date") ?? [];
        if (dates[0]) config.timelineStartPropertyId = dates[0].id;
        if (dates[1]) config.timelineEndPropertyId = dates[1].id;
        config.timelineZoom = "week";
      }
      if (type === "gallery") {
        const file = base?.properties.find((p) => p.type === "file");
        if (file) config.coverPropertyId = file.id;
        config.cardSize = "medium";
      }
      if (type === "kanban") {
        const groupable = base?.properties.find((p) => p.type === "select" || p.type === "status");
        if (groupable) config.groupByPropertyId = groupable.id;
      }
      if (type === "calendar") {
        const dated = base?.properties.find((p) => p.type === "date" || p.type === "createdAt" || p.type === "lastEditedAt");
        if (dated) config.calendarPropertyId = dated.id;
      }
      createViewMutation.mutate({ pageId, name: names[type], type, config });
    },
    [pageId, createViewMutation, t, base?.properties],
  );

  const handleColumnReorder = useCallback(
    (columnId: string, finishIndex: number) => {
      const order = table.getState().columnOrder;
      const startIndex = order.indexOf(columnId);
      if (startIndex === -1 || startIndex === finishIndex) return;
      table.setColumnOrder(reorder({ list: order, startIndex, finishIndex }));
      persistViewConfig();
    },
    [table, persistViewConfig],
  );

  const handleResizeEnd = useCallback(() => {
    persistViewConfig();
  }, [persistViewConfig]);

  const handleDraftSortsChange = useCallback(
    (sorts: ViewSortConfig[] | undefined) => {
      setDraftSorts(sorts && sorts.length > 0 ? sorts : undefined);
    },
    [setDraftSorts],
  );

  const handleDraftFiltersChange = useCallback(
    (filter: FilterGroup | undefined) => {
      setDraftFilter(filter);
    },
    [setDraftFilter],
  );

  const handleSaveDraft = useCallback(async () => {
    if (!activeView || !base) return;
    // `buildPromotedConfig` preserves all non-draft baseline fields
    // (widths/order/visibility) and only overwrites filter/sorts when the
    // draft has divergent values.
    const config = buildPromotedConfig(activeView.config);
    try {
      await updateViewMutation.mutateAsync({
        viewId: activeView.id,
        pageId: base.id,
        config,
      });
      resetDraft();
      notifications.show({ message: t("View updated for everyone") });
    } catch {
      // `useUpdateViewMutation` already shows a red toast on error and
      // rolls back the optimistic cache; keep the draft so the user can
      // retry without re-typing.
    }
  }, [
    activeView,
    base,
    buildPromotedConfig,
    resetDraft,
    t,
    updateViewMutation,
  ]);

  const { openRowId, openRow, closeRow } = useRowDetailModal();
  const handleCardClick = useCallback(
    (rowId: string) => openRow(rowId),
    [openRow],
  );

  const handleRowReorder = useCallback(
    (rowId: string, targetRowId: string, dropPosition: "above" | "below") => {
      const remainingRows = rows.filter((r) => r.id !== rowId);
      const targetIndex = remainingRows.findIndex((r) => r.id === targetRowId);
      if (targetIndex === -1) return;

      let lowerPos: string | null = null;
      let upperPos: string | null = null;
      if (dropPosition === "above") {
        lowerPos =
          targetIndex > 0 ? remainingRows[targetIndex - 1]?.position : null;
        upperPos = remainingRows[targetIndex]?.position ?? null;
      } else {
        lowerPos = remainingRows[targetIndex]?.position ?? null;
        upperPos =
          targetIndex < remainingRows.length - 1
            ? remainingRows[targetIndex + 1]?.position
            : null;
      }

      try {
        let newPosition: string;
        if (lowerPos && upperPos && lowerPos === upperPos) {
          newPosition = generateJitteredKeyBetween(lowerPos, null);
        } else {
          newPosition = generateJitteredKeyBetween(lowerPos, upperPos);
        }
        // Dropped into another group of a grouped table: the row takes
        // that group's values along with its new position.
        const groupKeys =
          effectiveView?.type === "table"
            ? [effectiveView.config?.groupByPropertyId, effectiveView.config?.subGroupByPropertyId].filter(
                (k): k is string => Boolean(k),
              )
            : [];
        const target = rows.find((r) => r.id === targetRowId);
        const dragged = rows.find((r) => r.id === rowId);
        const cells: Record<string, unknown> = {};
        if (target && dragged) {
          for (const k of groupKeys) {
            const want = target.cells?.[k] ?? null;
            if ((dragged.cells?.[k] ?? null) !== want) cells[k] = want;
          }
        }
        if (Object.keys(cells).length > 0) {
          updateRowMutation.mutate({ rowId, pageId, cells, position: newPosition });
        } else {
          reorderRowMutation.mutate({ rowId, pageId, position: newPosition });
        }
      } catch {
        // Position computation failed — skip silently.
      }
    },
    [rows, pageId, reorderRowMutation, updateRowMutation, effectiveView],
  );

  if (baseLoading || rowsLoading) {
    return <BaseTableSkeleton />;
  }
  if (baseError) {
    return (
      <Stack align="center" gap="sm" p="xl">
        <IconDatabase size={40} color="var(--mantine-color-gray-5)" />
        <Text c="dimmed">{t("Failed to load base")}</Text>
      </Stack>
    );
  }
  if (!base) return null;

  const banner = (
    <BaseViewDraftBanner
      isDirty={isDirty}
      canSave={canSave}
      onReset={resetDraft}
      onSave={handleSaveDraft}
      saving={updateViewMutation.isPending}
    />
  );

  const toolbar = (
    <BaseToolbar
      base={base}
      canEdit={canSave}
      activeView={effectiveView}
      views={views}
      table={table}
      onViewChange={handleViewChange}
      onAddView={structureEditable ? handleAddView : undefined}
      locked={Boolean(base.baseLocked)}
      onToggleLock={canSave ? handleToggleLock : undefined}
      onOpenRow={handleCardClick}
      onPersistViewConfig={persistViewConfig}
      onDraftSortsChange={handleDraftSortsChange}
      onDraftFiltersChange={handleDraftFiltersChange}
    />
  );

  if (embedded) {
    // Inline: banner + toolbar live inside the StickyBand (passed via
    // stickyBandPrelude). The page is the vertical scroll container.
    return (
      <>
        <ViewRenderer
          base={base}
          rows={rows}
          effectiveView={effectiveView}
          table={table}
          pageId={pageId}
          embedded={embedded}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onFetchNextPage={fetchNextPage}
          onCellUpdate={handleCellUpdate}
          onAddRow={canSave ? handleAddRow : undefined}
          onAddRowWithCells={canSave ? handleAddRowWithCells : undefined}
          editable={canSave}
          canEditStructure={structureEditable}
          onColumnReorder={handleColumnReorder}
          onResizeEnd={handleResizeEnd}
          onRowReorder={handleRowReorder}
          onCardClick={handleCardClick}
          persistViewConfig={persistViewConfig}
          scrollportEl={scrollportEl}
          stickyBandPrelude={
            <>
              {banner}
              {toolbar}
            </>
          }
        />
        <RowDetailModal
          base={base}
          rows={rows}
          openRowId={openRowId}
          canEdit={canSave}
          canEditStructure={structureEditable}
          templates={templates}
          onOpenRow={handleCardClick}
          onClose={closeRow}
        />
      </>
    );
  }

  // Standalone: banner + toolbar sit above the .tableScrollport, which
  // is the vertical scroll container. StickyBand inside contains only
  // the column-header row.
  return (
    <>
      <div
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        {titleSlot}
        {banner}
        {toolbar}
        {isCardView ? (
          <div
            ref={setScrollportEl}
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ViewRenderer
              base={base}
              rows={rows}
              effectiveView={effectiveView}
              table={table}
              pageId={pageId}
              embedded={embedded}
              hasNextPage={!!hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onFetchNextPage={fetchNextPage}
              onCellUpdate={handleCellUpdate}
              onAddRow={canSave ? handleAddRow : undefined}
              onAddRowWithCells={canSave ? handleAddRowWithCells : undefined}
              onColumnReorder={handleColumnReorder}
              onResizeEnd={handleResizeEnd}
              onRowReorder={handleRowReorder}
              onCardClick={handleCardClick}
              persistViewConfig={persistViewConfig}
              scrollportEl={scrollportEl}
              editable={canSave}
              canEditStructure={structureEditable}
            />
          </div>
        ) : (
          <div className={classes.tableScrollport} ref={setScrollportEl}>
            <ViewRenderer
              base={base}
              rows={rows}
              effectiveView={effectiveView}
              table={table}
              pageId={pageId}
              embedded={embedded}
              hasNextPage={!!hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onFetchNextPage={fetchNextPage}
              onCellUpdate={handleCellUpdate}
              onAddRow={canSave ? handleAddRow : undefined}
              onAddRowWithCells={canSave ? handleAddRowWithCells : undefined}
              onColumnReorder={handleColumnReorder}
              onResizeEnd={handleResizeEnd}
              onRowReorder={handleRowReorder}
              onCardClick={handleCardClick}
              persistViewConfig={persistViewConfig}
              scrollportEl={scrollportEl}
              editable={canSave}
              canEditStructure={structureEditable}
            />
          </div>
        )}
      </div>
      <RowDetailModal
        base={base}
        rows={rows}
        openRowId={openRowId}
        canEdit={canSave}
        canEditStructure={structureEditable}
        templates={templates}
        onOpenRow={handleCardClick}
        onClose={closeRow}
      />
    </>
  );
}

// Orders rows so each loaded child sits right after its parent, with a
// depth for the primary cell indentation. Children whose parent is not
// loaded stay in place at depth 0.
function nestSubItems(rows: IBaseRow[]): IBaseRow[] {
  const byParent = new Map<string, IBaseRow[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    if (row.parentRowId && ids.has(row.parentRowId)) {
      const list = byParent.get(row.parentRowId) ?? [];
      list.push(row);
      byParent.set(row.parentRowId, list);
    }
  }
  if (byParent.size === 0) return rows.map((r) => (r.depth ? { ...r, depth: 0 } : r));
  const out: IBaseRow[] = [];
  const seen = new Set<string>();
  const visit = (row: IBaseRow, depth: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ ...row, depth });
    for (const child of byParent.get(row.id) ?? []) visit(child, Math.min(depth + 1, 6));
  };
  for (const row of rows) {
    if (row.parentRowId && ids.has(row.parentRowId)) continue;
    visit(row, 0);
  }
  for (const row of rows) if (!seen.has(row.id)) visit(row, 0);
  return out;
}
