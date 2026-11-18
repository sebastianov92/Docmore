import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionIcon, Button, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChevronLeft, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IBase, IBaseRow, IBaseView, FilterGroup } from "@/features/base/types/base.types";
import { flattenRows, useBaseRowsQuery, useCreateRowMutation } from "@/features/base/queries/base-row-query";
import classes from "@/features/base/styles/calendar.module.css";
import {
  addMonths,
  dayKey,
  groupRowsByDay,
  isSameDay,
  monthGrid,
  resolveCalendarProperty,
  startOfMonth,
} from "./calendar-utils";

type Props = {
  base: IBase;
  effectiveView: IBaseView | undefined;
  editable: boolean;
  onCardClick: (rowId: string) => void;
};

// Month calendar: rows land on the day of the view's date property. The
// month's rows come from their own query so the view's own filter still
// applies and the table's row cache is left alone.
export function BaseCalendar({ base, effectiveView, editable, onCardClick }: Props) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const property = resolveCalendarProperty(
    base.properties,
    effectiveView?.config?.calendarPropertyId,
  );
  const days = useMemo(() => monthGrid(month), [month]);
  const rangeStart = days[0];
  const rangeEnd = new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1);

  const filter = useMemo<FilterGroup | undefined>(() => {
    if (!property) return undefined;
    const viewFilter = effectiveView?.config?.filter;
    const children: FilterGroup["children"] = [
      { propertyId: property.id, op: "onOrAfter", value: rangeStart.toISOString() },
      { propertyId: property.id, op: "before", value: rangeEnd.toISOString() },
    ];
    if (viewFilter && viewFilter.children.length > 0) children.unshift(viewFilter);
    return { op: "and", children };
  }, [property, effectiveView?.config?.filter, rangeStart.getTime(), rangeEnd.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useBaseRowsQuery(property ? base.id : undefined, filter);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rows = useMemo(() => flattenRows(query.data), [query.data]);
  const byDay = useMemo(() => (property ? groupRowsByDay(rows, property) : new Map()), [rows, property]);

  const createRow = useCreateRowMutation();
  const canAddOnDay = editable && property?.type === "date";
  const addRow = useCallback(
    (day: Date) => {
      if (!property || !canAddOnDay) return;
      const local = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      createRow.mutate({ pageId: base.id, cells: { [property.id]: local.toISOString() } });
    },
    [property, canAddOnDay, createRow, base.id],
  );

  const primary = base.properties.find((p) => p.isPrimary);
  const titleOf = (row: IBaseRow) => {
    const value = primary ? row.cells[primary.id] : undefined;
    return typeof value === "string" && value.trim() ? value : t("Untitled");
  };
  const today = new Date();
  const monthLabel = month.toLocaleDateString(i18n.language, { month: "long", year: "numeric" });
  const weekdays = useMemo(
    () => monthGrid(month).slice(0, 7).map((d) => d.toLocaleDateString(i18n.language, { weekday: "short" })),
    [month, i18n.language],
  );

  if (!property) {
    return (
      <div className={classes.empty}>
        <Text c="dimmed" size="sm">
          {t("Add a date property to this base to show its rows on a calendar.")}
        </Text>
      </div>
    );
  }

  return (
    <div className={classes.calendar}>
      <Group justify="space-between" className={classes.header}>
        <Group gap={4}>
          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setMonth(addMonths(month, -1))} aria-label={t("Previous month")}>
            <IconChevronLeft size={16} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setMonth(addMonths(month, 1))} aria-label={t("Next month")}>
            <IconChevronRight size={16} />
          </ActionIcon>
          <Button variant="subtle" color="gray" size="compact-xs" onClick={() => setMonth(startOfMonth(new Date()))}>
            {t("Today")}
          </Button>
        </Group>
        <Text fw={600} size="sm" className={classes.monthLabel}>
          {monthLabel}
        </Text>
        <Text size="xs" c="dimmed">
          {t("By {{name}}", { name: property.name })}
        </Text>
      </Group>
      <div className={classes.weekdays}>
        {weekdays.map((w) => (
          <div key={w} className={classes.weekday}>
            {w}
          </div>
        ))}
      </div>
      <div className={classes.grid}>
        {days.map((day) => {
          const key = dayKey(day);
          const dayRows = byDay.get(key) ?? [];
          const outside = day.getMonth() !== month.getMonth();
          return (
            <div
              key={key}
              className={`${classes.day} ${outside ? classes.dayOutside : ""} ${isSameDay(day, today) ? classes.dayToday : ""}`}
            >
              <div className={classes.dayHead}>
                <span className={classes.dayNumber}>{day.getDate()}</span>
                {canAddOnDay && (
                  <Tooltip label={t("New row on this day")} openDelay={400}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="xs"
                      className={classes.dayAdd}
                      onClick={() => addRow(day)}
                      aria-label={t("New row on this day")}
                    >
                      <IconPlus size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </div>
              <div className={classes.cards}>
                {dayRows.map((row) => (
                  <UnstyledButton key={row.id} className={classes.card} onClick={() => onCardClick(row.id)}>
                    <Text size="xs" lineClamp={2}>
                      {titleOf(row)}
                    </Text>
                  </UnstyledButton>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
