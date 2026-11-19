import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { Badge } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { IBase, IBaseRow, IBaseView, NO_VALUE_CHOICE_ID } from "@/features/base/types/base.types";
import { partitionRowsByGroup } from "@/features/base/hooks/use-kanban-groups";
import { CardProperties } from "@/features/base/components/views/cards/card-properties";
import { cardProperties, rowTitle } from "@/features/base/components/views/cards/card-utils";
import classes from "@/features/base/styles/list.module.css";

type BaseListProps = {
  base: IBase;
  rows: IBaseRow[];
  effectiveView: IBaseView | undefined;
  embedded?: boolean;
  onCardClick: (rowId: string) => void;
  onAddRow?: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNextPage: () => void;
};

// Compact rows: title first, then the filled properties inline. An
// optional select/status grouping folds rows under collapsible headers.
export function BaseList({
  base,
  rows,
  effectiveView,
  embedded,
  onCardClick,
  onAddRow,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
}: BaseListProps) {
  const { t } = useTranslation();
  const primary = useMemo(() => base.properties.find((p) => p.isPrimary), [base.properties]);
  const properties = useMemo(() => cardProperties(base, effectiveView, 5), [base, effectiveView]);
  const groupBy = effectiveView?.config?.groupByPropertyId;
  const groupProperty = useMemo(
    () => (groupBy ? base.properties.find((p) => p.id === groupBy) : undefined),
    [groupBy, base.properties],
  );
  const groupable = groupProperty?.type === "select" || groupProperty?.type === "status";
  const hiddenChoiceIds = effectiveView?.config?.hiddenChoiceIds;
  const choiceOrder = effectiveView?.config?.choiceOrder;
  const { columns } = useMemo(
    () => partitionRowsByGroup(rows, groupable ? groupProperty : undefined, hiddenChoiceIds, choiceOrder),
    [rows, groupable, groupProperty, hiddenChoiceIds, choiceOrder],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    const target = endRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onFetchNextPage();
      },
      { root: embedded ? null : rootRef.current, threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onFetchNextPage, embedded]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderRow = (row: IBaseRow) => {
    const title = rowTitle(row, primary);
    return (
      <div
        key={row.id}
        className={classes.row}
        role="button"
        tabIndex={0}
        data-row-id={row.id}
        onClick={() => onCardClick(row.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCardClick(row.id);
          }
        }}
      >
        <div className={clsx(classes.rowTitle, !title && classes.rowTitleEmpty)}>
          {title || t("Untitled")}
        </div>
        <div className={classes.rowProps}>
          <CardProperties row={row} properties={properties} layout="inline" />
        </div>
      </div>
    );
  };

  const addRow = onAddRow ? (
    <div className={classes.addRow} role="button" tabIndex={0} onClick={onAddRow}>
      <IconPlus size={14} />
      <span>{t("New row")}</span>
    </div>
  ) : null;

  return (
    <div className={classes.root} data-standalone={!embedded || undefined} ref={rootRef}>
      {groupable ? (
        columns.map((column) => {
          const isCollapsed = collapsed.has(column.key);
          return (
            <div key={column.key} className={classes.group}>
              <button type="button" className={classes.groupHeader} onClick={() => toggle(column.key)}>
                {isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                <Badge color={column.color ?? "gray"} variant="light" size="sm">
                  {column.key === NO_VALUE_CHOICE_ID ? t("No value") : column.name || t("Untitled")}
                </Badge>
                <span className={classes.groupCount}>{column.rows.length}</span>
              </button>
              {!isCollapsed && column.rows.map(renderRow)}
            </div>
          );
        })
      ) : rows.length === 0 && !onAddRow ? (
        <div className={classes.empty}>{t("No rows yet")}</div>
      ) : (
        rows.map(renderRow)
      )}
      {addRow}
      <div ref={endRef} className={classes.sentinel} />
    </div>
  );
}
