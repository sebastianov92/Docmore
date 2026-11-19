import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  ActionIcon,
  Tooltip,
  Badge,
  Switch,
} from "@mantine/core";
import { Table } from "@tanstack/react-table";
import {
  IconSortAscending,
  IconFilter,
  IconEye,
  IconDownload,
  IconUpload,
  IconLock,
  IconLockOpen,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import {
  IBase,
  IBaseRow,
  IBaseView,
  ViewSortConfig,
  FilterCondition,
  FilterGroup,
  BaseViewType,
} from "@/features/base/types/base.types";
import { exportBaseToCsv } from "@/features/base/services/base-service";
import { ViewTabs } from "@/features/base/components/views/view-tabs";
import { ViewSortConfigPopover } from "@/features/base/components/views/view-sort-config";
import { ViewFilterConfigPopover } from "@/features/base/components/views/view-filter-config";
import { ViewFieldVisibility } from "@/features/base/components/views/view-field-visibility";
import { KanbanGroupByPicker } from "@/features/base/components/views/kanban/kanban-group-by-picker";
import { CalendarDatePicker } from "@/features/base/components/views/calendar/calendar-date-picker";
import { useUpdateViewMutation } from "@/features/base/queries/base-view-query";
import { useTranslation } from "react-i18next";
import classes from "@/features/base/styles/grid.module.css";
import { CsvImportModal } from "@/features/base/csv-import/csv-import-modal";
import { useAtomValue } from "jotai";
import { basePublicContextAtom } from "@/features/base/atoms/public-context-atom";
import { RowTemplatesMenu } from "@/features/base/components/templates/row-templates-menu";
import { GalleryControls } from "@/features/base/components/views/gallery/gallery-controls";

type BaseToolbarProps = {
  base: IBase;
  // Effective view — baseline merged with any local draft. Badge counts
  // and sort/filter popover seed data read from this. The real baseline
  // only enters via `onDraftSortsChange` / `onDraftFiltersChange`
  // callbacks defined by the parent.
  activeView: IBaseView | undefined;
  views: IBaseView[];
  table: Table<IBaseRow>;
  onViewChange: (viewId: string) => void;
  onAddView?: (type?: BaseViewType) => void;
  onPersistViewConfig: () => void;
  onDraftSortsChange: (sorts: ViewSortConfig[] | undefined) => void;
  onDraftFiltersChange: (filter: FilterGroup | undefined) => void;
  // Shows the actions that change data (CSV import).
  canEdit?: boolean;
  // Structure lock state and its toggle (editors only).
  locked?: boolean;
  onToggleLock?: () => void;
  // Opens a row in the detail modal (templates menu).
  onOpenRow?: (rowId: string) => void;
};

export function BaseToolbar({
  base,
  activeView,
  views,
  table,
  onViewChange,
  onAddView,
  onPersistViewConfig,
  onDraftSortsChange,
  onDraftFiltersChange,
  canEdit = false,
  locked = false,
  onToggleLock,
  onOpenRow,
}: BaseToolbarProps) {
  const { t } = useTranslation();
  const [sortOpened, setSortOpened] = useState(false);
  const [filterOpened, setFilterOpened] = useState(false);
  const [fieldsOpened, setFieldsOpened] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importOpened, setImportOpened] = useState(false);
  const publicCtx = useAtomValue(basePublicContextAtom);
  const toolbarRightRef = useRef<HTMLDivElement>(null);

  // Mantine `<Popover>`'s built-in dismiss handlers don't fire reliably
  // for the toolbar popovers (same issue that drove the property menu to
  // use custom listeners in `grid-container.tsx`). Close any open toolbar
  // popover on outside mousedown AND on ESC.
  useEffect(() => {
    if (!sortOpened && !filterOpened && !fieldsOpened) return;
    const closeAll = () => {
      setSortOpened(false);
      setFilterOpened(false);
      setFieldsOpened(false);
    };
    const mouseHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (toolbarRightRef.current?.contains(target)) return;
      // Ignore clicks that land inside any Mantine popover dropdown
      // (role=dialog), any Select/Combobox dropdown (role=listbox, the
      // container; option elements have role=option), or anything
      // rendered into Mantine's shared portal node. Without these, a
      // nested Select inside the popover would close the parent.
      if (target.closest('[role="dialog"]')) return;
      if (target.closest('[role="listbox"]')) return;
      if (target.closest('[role="option"]')) return;
      if (target.closest("[data-mantine-shared-portal-node]")) return;
      closeAll();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    const id = setTimeout(() => {
      document.addEventListener("mousedown", mouseHandler);
    }, 0);
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", mouseHandler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [sortOpened, filterOpened, fieldsOpened]);

  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportBaseToCsv(base.id);
    } catch (err) {
      notifications.show({
        color: "red",
        message: t("Failed to export CSV"),
      });
    } finally {
      setExporting(false);
    }
  }, [base.id, exporting, t]);

  const openToolbar = useCallback((panel: "sort" | "filter" | "fields") => {
    setSortOpened(panel === "sort" ? (v) => !v : false);
    setFilterOpened(panel === "filter" ? (v) => !v : false);
    setFieldsOpened(panel === "fields" ? (v) => !v : false);
  }, []);

  const sorts = activeView?.config?.sorts ?? [];
  // Stored view config uses the engine's filter tree. The popover edits
  // an AND-only flat list; we unwrap the top-level group's children when
  // reading and rewrap on save.
  const conditions = useMemo<FilterCondition[]>(() => {
    const filter = activeView?.config?.filter;
    if (!filter || filter.op !== "and") return [];
    return filter.children.filter(
      (c): c is FilterCondition => !("children" in c),
    );
  }, [activeView?.config?.filter]);

  const hiddenFieldCount = useMemo(() => {
    const cols = table.getAllLeafColumns().filter((col) => col.id !== "__row_number");
    return cols.filter((col) => col.getCanHide() && !col.getIsVisible()).length;
  }, [table, table.getState().columnVisibility]);

  const updateViewMutation = useUpdateViewMutation();
  const isKanban = activeView?.type === "kanban";
  const isCalendar = activeView?.type === "calendar";
  const isList = activeView?.type === "list";
  const isGallery = activeView?.type === "gallery";
  const isTimeline = activeView?.type === "timeline";
  const isTable = activeView?.type === "table";

  const handleGroupByChange = useCallback(
    (propertyId: string) => {
      if (!activeView) return;
      updateViewMutation.mutate({
        viewId: activeView.id,
        pageId: base.id,
        config: { ...activeView.config, groupByPropertyId: propertyId },
      });
    },
    [activeView, base.id, updateViewMutation],
  );

  // Null deletes the key on the server (config patch semantics).
  const handleGroupByClear = useCallback(() => {
    if (!activeView) return;
    updateViewMutation.mutate({
      viewId: activeView.id,
      pageId: base.id,
      config: {
        ...activeView.config,
        groupByPropertyId: null,
        hiddenChoiceIds: null,
        choiceOrder: null,
        subGroupByPropertyId: null,
      } as any,
    });
  }, [activeView, base.id, updateViewMutation]);

  const handleCoverChange = useCallback(
    (propertyId: string | null) => {
      if (!activeView) return;
      updateViewMutation.mutate({
        viewId: activeView.id,
        pageId: base.id,
        config: { ...activeView.config, coverPropertyId: propertyId } as any,
      });
    },
    [activeView, base.id, updateViewMutation],
  );

  const handleCardSizeChange = useCallback(
    (cardSize: "small" | "medium" | "large") => {
      if (!activeView) return;
      updateViewMutation.mutate({
        viewId: activeView.id,
        pageId: base.id,
        config: { ...activeView.config, cardSize },
      });
    },
    [activeView, base.id, updateViewMutation],
  );

  const setViewConfig = useCallback(
    (patch: Record<string, unknown>) => {
      if (!activeView) return;
      updateViewMutation.mutate({
        viewId: activeView.id,
        pageId: base.id,
        config: { ...activeView.config, ...patch } as any,
      });
    },
    [activeView, base.id, updateViewMutation],
  );

  const handleCalendarPropertyChange = useCallback(
    (propertyId: string) => {
      if (!activeView) return;
      updateViewMutation.mutate({
        viewId: activeView.id,
        pageId: base.id,
        config: { ...activeView.config, calendarPropertyId: propertyId },
      });
    },
    [activeView, base.id, updateViewMutation],
  );

  const handleSortsChange = useCallback(
    (newSorts: ViewSortConfig[]) => {
      // Normalize empty to undefined so the draft hook can drop the `sorts`
      // axis (and remove its localStorage entry when both axes go clean).
      onDraftSortsChange(newSorts.length > 0 ? newSorts : undefined);
    },
    [onDraftSortsChange],
  );

  const handleFiltersChange = useCallback(
    (newConditions: FilterCondition[]) => {
      // Wrap the AND-flat popover output into the engine's FilterGroup shape.
      // Pass `undefined` to drop the filter axis from the draft entirely.
      const filter: FilterGroup | undefined =
        newConditions.length > 0
          ? { op: "and", children: newConditions }
          : undefined;
      onDraftFiltersChange(filter);
    },
    [onDraftFiltersChange],
  );

  return (
    <div className={classes.toolbar}>
      <ViewTabs
        views={views}
        activeViewId={activeView?.id}
        pageId={base.id}
        onViewChange={onViewChange}
        onAddView={onAddView}
      />

      {isKanban && (
        <KanbanGroupByPicker
          properties={base.properties}
          value={activeView?.config?.groupByPropertyId ?? null}
          onChange={handleGroupByChange}
          size="xs"
        />
      )}
      {isCalendar && (
        <CalendarDatePicker
          properties={base.properties}
          value={activeView?.config?.calendarPropertyId ?? null}
          onChange={handleCalendarPropertyChange}
          size="xs"
        />
      )}
      {(isList || isTable) && canEdit && (
        <KanbanGroupByPicker
          properties={base.properties}
          value={activeView?.config?.groupByPropertyId ?? null}
          onChange={handleGroupByChange}
          onClear={handleGroupByClear}
          size="xs"
        />
      )}
      {isTable && canEdit && activeView?.config?.groupByPropertyId && (
        <KanbanGroupByPicker
          properties={base.properties.filter((p) => p.id !== activeView?.config?.groupByPropertyId)}
          value={activeView?.config?.subGroupByPropertyId ?? null}
          onChange={(propertyId) => setViewConfig({ subGroupByPropertyId: propertyId })}
          onClear={() => setViewConfig({ subGroupByPropertyId: null })}
          placeholder={t("Sub-group by…")}
          size="xs"
        />
      )}
      {isTimeline && canEdit && (
        <>
          <CalendarDatePicker
            properties={base.properties.filter((p) => p.type === "date")}
            value={activeView?.config?.timelineStartPropertyId ?? null}
            onChange={(propertyId) => setViewConfig({ timelineStartPropertyId: propertyId })}
            size="xs"
          />
          <CalendarDatePicker
            properties={base.properties.filter((p) => p.type === "date")}
            value={activeView?.config?.timelineEndPropertyId ?? null}
            onChange={(propertyId) => setViewConfig({ timelineEndPropertyId: propertyId })}
            size="xs"
          />
        </>
      )}
      {(isTable || isList) && canEdit && (
        <Tooltip label={t("Nest sub-items under their parent")}>
          <Switch
            size="xs"
            label={t("Sub-items")}
            checked={activeView?.config?.subItems !== false}
            onChange={(e) => setViewConfig({ subItems: e.currentTarget.checked })}
            aria-label={t("Sub-items")}
          />
        </Tooltip>
      )}
      {isGallery && canEdit && (
        <GalleryControls
          properties={base.properties}
          coverPropertyId={activeView?.config?.coverPropertyId ?? null}
          cardSize={activeView?.config?.cardSize ?? "medium"}
          onCoverChange={handleCoverChange}
          onSizeChange={handleCardSizeChange}
        />
      )}

      <div className={classes.toolbarRight} ref={toolbarRightRef}>
        {canEdit && !publicCtx && onOpenRow && (
          <RowTemplatesMenu base={base} onOpenRow={onOpenRow} />
        )}
        {!publicCtx && (locked || onToggleLock) && (
          <Tooltip
            label={
              locked
                ? onToggleLock
                  ? t("Locked: properties and views can't change. Click to unlock.")
                  : t("Locked: properties and views can't change.")
                : t("Lock base")
            }
          >
            <ActionIcon
              variant="subtle"
              size="sm"
              color={locked ? "orange" : "gray"}
              onClick={onToggleLock}
              disabled={!onToggleLock}
              aria-label={locked ? t("Unlock base") : t("Lock base")}
              data-testid="base-lock-toggle"
            >
              {locked ? <IconLock size={16} /> : <IconLockOpen size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
        {!publicCtx && (
          <Tooltip label={t("Export CSV")}>
            <ActionIcon
              variant="subtle"
              size="sm"
              color="gray"
              loading={exporting}
              onClick={handleExport}
            >
              <IconDownload size={16} />
            </ActionIcon>
          </Tooltip>
        )}
        {canEdit && (
          <Tooltip label={t("Import CSV")}>
            <ActionIcon
              variant="subtle"
              size="sm"
              color="gray"
              onClick={() => setImportOpened(true)}
              aria-label={t("Import CSV")}
            >
              <IconUpload size={16} />
            </ActionIcon>
          </Tooltip>
        )}
        {canEdit && (
          <CsvImportModal
            base={base}
            opened={importOpened}
            onClose={() => setImportOpened(false)}
          />
        )}

        <ViewFilterConfigPopover
          opened={filterOpened}
          onClose={() => setFilterOpened(false)}
          conditions={conditions}
          properties={base.properties}
          onChange={handleFiltersChange}
        >
          <Tooltip label={t("Filter")}>
            <ActionIcon
              variant="subtle"
              size="sm"
              color={conditions.length > 0 ? "blue" : "gray"}
              onClick={() => openToolbar("filter")}
            >
              <IconFilter size={16} />
              {conditions.length > 0 && (
                <Badge
                  size="xs"
                  circle
                  color="blue"
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
                    padding: 0,
                    width: 14,
                    height: 14,
                    minWidth: 14,
                    fontSize: 9,
                  }}
                >
                  {conditions.length}
                </Badge>
              )}
            </ActionIcon>
          </Tooltip>
        </ViewFilterConfigPopover>

        <ViewSortConfigPopover
          opened={sortOpened}
          onClose={() => setSortOpened(false)}
          sorts={sorts}
          properties={base.properties}
          onChange={handleSortsChange}
        >
          <Tooltip label={t("Sort")}>
            <ActionIcon
              variant="subtle"
              size="sm"
              color={sorts.length > 0 ? "blue" : "gray"}
              onClick={() => openToolbar("sort")}
            >
              <IconSortAscending size={16} />
              {sorts.length > 0 && (
                <Badge
                  size="xs"
                  circle
                  color="blue"
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -2,
                    padding: 0,
                    width: 14,
                    height: 14,
                    minWidth: 14,
                    fontSize: 9,
                  }}
                >
                  {sorts.length}
                </Badge>
              )}
            </ActionIcon>
          </Tooltip>
        </ViewSortConfigPopover>

        {!isKanban && (
          <ViewFieldVisibility
            opened={fieldsOpened}
            onClose={() => setFieldsOpened(false)}
            table={table}
            properties={base.properties}
            onPersist={onPersistViewConfig}
          >
            <Tooltip label={t("Hide fields")}>
              <ActionIcon
                variant="subtle"
                size="sm"
                color={hiddenFieldCount > 0 ? "blue" : "gray"}
                onClick={() => openToolbar("fields")}
              >
                <IconEye size={16} />
                {hiddenFieldCount > 0 && (
                  <Badge
                    size="xs"
                    circle
                    color="blue"
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      padding: 0,
                      width: 14,
                      height: 14,
                      minWidth: 14,
                      fontSize: 9,
                    }}
                  >
                    {hiddenFieldCount}
                  </Badge>
                )}
              </ActionIcon>
            </Tooltip>
          </ViewFieldVisibility>
        )}
      </div>
    </div>
  );
}
