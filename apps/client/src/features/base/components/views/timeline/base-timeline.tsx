import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { ActionIcon, Group, SegmentedControl, Text, Tooltip } from "@mantine/core";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { FilterGroup, IBase, IBaseRow, IBaseView } from "@/features/base/types/base.types";
import { flattenRows, useBaseRowsQuery, useUpdateRowMutation } from "@/features/base/queries/base-row-query";
import { useUpdateViewMutation } from "@/features/base/queries/base-view-query";
import classes from "@/features/base/styles/timeline.module.css";

type Props = {
  base: IBase;
  effectiveView: IBaseView | undefined;
  embedded?: boolean;
  editable: boolean;
  onCardClick: (rowId: string) => void;
};

type Zoom = "day" | "week" | "month";
const DAY_PX: Record<Zoom, number> = { day: 56, week: 20, month: 8 };
const MS_DAY = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

// Bars on a day axis: start date property, optional end date property.
// Dragging a bar moves it (same length); rows without a date sit at the end.
export function BaseTimeline({ base, effectiveView, embedded, editable, onCardClick }: Props) {
  const { t, i18n } = useTranslation();
  const config = effectiveView?.config ?? {};
  const startProp = base.properties.find((p) => p.id === config.timelineStartPropertyId && p.type === "date");
  const endProp = base.properties.find((p) => p.id === config.timelineEndPropertyId && p.type === "date");
  const zoom: Zoom = config.timelineZoom ?? "week";
  const dayPx = DAY_PX[zoom];
  const [origin, setOrigin] = useState(() => addDays(startOfDay(new Date()), -14));
  const days = zoom === "day" ? 42 : zoom === "week" ? 120 : 365;
  const rangeEnd = addDays(origin, days);

  const filter = useMemo<FilterGroup | undefined>(() => {
    if (!startProp) return undefined;
    const viewFilter = effectiveView?.config?.filter;
    const children: FilterGroup["children"] = [
      { propertyId: startProp.id, op: "before", value: rangeEnd.toISOString() },
    ];
    if (viewFilter && viewFilter.children.length > 0) children.unshift(viewFilter);
    return { op: "and", children };
  }, [startProp, effectiveView?.config?.filter, rangeEnd.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useBaseRowsQuery(startProp ? base.id : undefined, filter);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rows = useMemo(() => flattenRows(query.data), [query.data]);
  const updateRow = useUpdateRowMutation();
  const updateView = useUpdateViewMutation();
  const primary = base.properties.find((p) => p.isPrimary);
  const titleOf = (row: IBaseRow) => {
    const v = primary ? row.cells[primary.id] : undefined;
    return typeof v === "string" && v.trim() ? v : t("Untitled");
  };

  const bars = useMemo(() => {
    return rows
      .map((row) => {
        const start = startProp ? parseDate(row.cells[startProp.id]) : null;
        const endRaw = endProp ? parseDate(row.cells[endProp.id]) : null;
        const end = endRaw && start && endRaw >= start ? endRaw : start;
        return { row, start, end };
      })
      .filter((b) => b.start && b.end && b.end >= origin);
  }, [rows, startProp, endProp, origin]);
  const undated = useMemo(() => rows.filter((row) => !startProp || !parseDate(row.cells[startProp.id])), [rows, startProp]);

  const axis = useMemo(() => {
    const cells: { label: string; width: number; today: boolean }[] = [];
    const today = startOfDay(new Date()).getTime();
    if (zoom === "day") {
      for (let i = 0; i < days; i++) {
        const d = addDays(origin, i);
        cells.push({ label: d.toLocaleDateString(i18n.language, { day: "numeric", month: "short" }), width: dayPx, today: d.getTime() === today });
      }
    } else if (zoom === "week") {
      for (let i = 0; i < days; i += 7) {
        const d = addDays(origin, i);
        cells.push({ label: d.toLocaleDateString(i18n.language, { day: "numeric", month: "short" }), width: dayPx * 7, today: today >= d.getTime() && today < addDays(d, 7).getTime() });
      }
    } else {
      let i = 0;
      while (i < days) {
        const d = addDays(origin, i);
        const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        const span = Math.min(Math.round((monthEnd.getTime() - d.getTime()) / MS_DAY), days - i);
        cells.push({ label: d.toLocaleDateString(i18n.language, { month: "short", year: "2-digit" }), width: dayPx * span, today: today >= d.getTime() && today < monthEnd.getTime() });
        i += span;
      }
    }
    return cells;
  }, [zoom, origin, days, dayPx, i18n.language]);

  const todayX = ((startOfDay(new Date()).getTime() - origin.getTime()) / MS_DAY) * dayPx;
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayX - el.clientWidth / 3);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag a bar: shift start (and end) by whole days.
  const drag = useRef<{ rowId: string; startX: number; start: Date; end: Date; moved: boolean } | null>(null);
  const onBarPointerDown = useCallback(
    (e: React.PointerEvent, bar: { row: IBaseRow; start: Date; end: Date }) => {
      if (!editable) return;
      drag.current = { rowId: bar.row.id, startX: e.clientX, start: bar.start, end: bar.end, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [editable],
  );
  const onBarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const el = e.currentTarget as HTMLElement;
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) > 3) d.moved = true;
      el.style.transform = `translateX(${Math.round(dx / dayPx) * dayPx}px)`;
    },
    [dayPx],
  );
  const onBarPointerUp = useCallback(
    (e: React.PointerEvent, bar: { row: IBaseRow }) => {
      const d = drag.current;
      drag.current = null;
      const el = e.currentTarget as HTMLElement;
      el.style.transform = "";
      if (!d) return;
      if (!d.moved) {
        onCardClick(bar.row.id);
        return;
      }
      const shift = Math.round((e.clientX - d.startX) / dayPx);
      if (shift === 0 || !startProp) return;
      const cells: Record<string, unknown> = { [startProp.id]: addDays(d.start, shift).toISOString() };
      if (endProp) cells[endProp.id] = addDays(d.end, shift).toISOString();
      updateRow.mutate({ rowId: bar.row.id, pageId: base.id, cells });
    },
    [dayPx, startProp, endProp, updateRow, base.id, onCardClick],
  );

  const setZoom = (value: Zoom) => {
    if (!effectiveView) return;
    updateView.mutate({ viewId: effectiveView.id, pageId: base.id, config: { ...effectiveView.config, timelineZoom: value } });
  };

  if (!startProp) {
    return <div className={classes.empty}>{t("Pick a date property for the timeline in the toolbar.")}</div>;
  }

  const totalWidth = days * dayPx;
  return (
    <div className={classes.root} data-standalone={!embedded || undefined}>
      <div className={classes.header}>
        <Group gap={4}>
          <ActionIcon variant="subtle" size="sm" onClick={() => setOrigin(addDays(origin, -Math.round(days / 2)))} aria-label={t("Earlier")}>
            <IconChevronLeft size={16} />
          </ActionIcon>
          <ActionIcon variant="subtle" size="sm" onClick={() => setOrigin(addDays(startOfDay(new Date()), -14))} aria-label={t("Today")}>
            <Text size="xs">{t("Today")}</Text>
          </ActionIcon>
          <ActionIcon variant="subtle" size="sm" onClick={() => setOrigin(addDays(origin, Math.round(days / 2)))} aria-label={t("Later")}>
            <IconChevronRight size={16} />
          </ActionIcon>
        </Group>
        <SegmentedControl
          size="xs"
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          data={[
            { value: "day", label: t("Day") },
            { value: "week", label: t("Week") },
            { value: "month", label: t("Month") },
          ]}
        />
        <Text size="xs" c="dimmed">
          {bars.length} {t("on the timeline")}{undated.length ? ` · ${undated.length} ${t("undated")}` : ""}
        </Text>
      </div>
      <div className={classes.scroller} ref={scrollerRef} data-testid="timeline">
        <div className={classes.canvas} style={{ width: totalWidth }}>
          <div className={classes.axis}>
            {axis.map((cell, i) => (
              <div key={i} className={clsx(classes.axisCell, cell.today && classes.axisCellToday)} style={{ width: cell.width }}>
                {cell.label}
              </div>
            ))}
          </div>
          {todayX >= 0 && todayX <= totalWidth && <div className={classes.todayLine} style={{ left: todayX }} />}
          {bars.map(({ row, start, end }) => {
            const left = Math.max(0, ((start!.getTime() - origin.getTime()) / MS_DAY) * dayPx);
            const width = Math.max(dayPx, ((end!.getTime() - start!.getTime()) / MS_DAY + 1) * dayPx - 2);
            const blocked = Array.isArray(row.blockedBy) && row.blockedBy.length > 0;
            return (
              <div key={row.id} className={classes.row}>
                <Tooltip label={blocked ? t("Blocked by {{count}} rows", { count: row.blockedBy!.length }) : titleOf(row)} openDelay={400}>
                  <div
                    className={clsx(classes.bar, blocked && classes.barBlocked)}
                    style={{ left, width }}
                    onPointerDown={(e) => onBarPointerDown(e, { row, start: start!, end: end! })}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={(e) => onBarPointerUp(e, { row })}
                    onClick={(e) => {
                      if (!editable) {
                        e.stopPropagation();
                        onCardClick(row.id);
                      }
                    }}
                    data-row-id={row.id}
                  >
                    {titleOf(row)}
                  </div>
                </Tooltip>
              </div>
            );
          })}
          {undated.map((row) => (
            <div key={row.id} className={classes.row}>
              <div className={clsx(classes.bar, classes.barUndated)} style={{ left: 8, width: 160 }} onClick={() => onCardClick(row.id)}>
                {titleOf(row)}
              </div>
            </div>
          ))}
          {bars.length === 0 && undated.length === 0 && <div className={classes.empty}>{t("No rows yet")}</div>}
        </div>
      </div>
    </div>
  );
}
