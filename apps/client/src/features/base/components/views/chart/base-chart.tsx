import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Group, SegmentedControl, Select, Switch, Table, Text, Tooltip } from "@mantine/core";
import { IconChartBar, IconChartDonut, IconChartLine, IconChartPie, IconHash } from "@tabler/icons-react";
import { IBase, IBaseView } from "@/features/base/types/base.types";
import { flattenRows, useBaseRowsQuery } from "@/features/base/queries/base-row-query";
import { useUpdateViewMutation } from "@/features/base/queries/base-view-query";
import { useBaseRowReferences } from "@/features/base/hooks/use-base-row-references";
import {
  aggregateRows,
  bucketRows,
  ChartAggregate,
  ChartPoint,
  ChartType,
  DATE_TYPES,
  DateBucket,
  formatValue,
  GROUPABLE_TYPES,
  NUMERIC_TYPES,
} from "./chart-data";
import { BarChart, LineChart, PieChart } from "./chart-svg";
import classes from "@/features/base/styles/chart.module.css";

type Props = {
  base: IBase;
  effectiveView: IBaseView | undefined;
  embedded?: boolean;
  editable: boolean;
};

// One chart over the rows the view's filter lets through: rows grouped by
// one property, counted or aggregated over a number property.
export function BaseChart({ base, effectiveView, embedded, editable }: Props) {
  const { t, i18n } = useTranslation();
  const config = effectiveView?.config ?? {};
  const chartType: ChartType = config.chartType ?? "bar";
  const xProp = base.properties.find((p) => p.id === config.chartXPropertyId && GROUPABLE_TYPES.has(p.type));
  const yProp = base.properties.find((p) => p.id === config.chartYPropertyId && NUMERIC_TYPES.has(p.type));
  const aggregate: ChartAggregate = yProp ? (config.chartAggregate && config.chartAggregate !== "count" ? config.chartAggregate : "sum") : "count";
  const dateBucket: DateBucket = config.chartDateBucket ?? "month";
  const showValues = config.chartShowValues !== false;
  const [showTable, setShowTable] = useState(false);

  const query = useBaseRowsQuery(base.id, config.filter);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rows = useMemo(() => flattenRows(query.data), [query.data]);
  const references = useBaseRowReferences(base.id);

  const labels = useMemo(
    () => ({ noValue: t("No value"), yes: t("Checked"), no: t("Unchecked"), other: t("Other"), all: t("All rows") }),
    [t],
  );
  const points = useMemo<ChartPoint[]>(() => {
    const buckets = bucketRows(rows, xProp, { references, dateBucket, locale: i18n.language, labels });
    return buckets.map((b) => ({
      key: b.key,
      label: b.label,
      color: b.color,
      value: aggregateRows(b.rows, yProp, aggregate),
      count: b.rows.length,
    }));
  }, [rows, xProp, yProp, aggregate, dateBucket, references, i18n.language, labels]);
  const total = useMemo(() => aggregateRows(rows, yProp, aggregate), [rows, yProp, aggregate]);

  const updateView = useUpdateViewMutation();
  const patch = (p: Record<string, unknown>) => {
    if (!effectiveView) return;
    updateView.mutate({ viewId: effectiveView.id, pageId: base.id, config: { ...effectiveView.config, ...p } as any });
  };

  const aggregateLabel: Record<ChartAggregate, string> = {
    count: t("Count"),
    sum: t("Sum"),
    avg: t("Average"),
    min: t("Min"),
    max: t("Max"),
  };
  const caption = yProp ? `${aggregateLabel[aggregate]} · ${yProp.name}` : t("Count");

  const typeOptions = [
    { value: "bar", icon: IconChartBar, label: t("Bar") },
    { value: "line", icon: IconChartLine, label: t("Line") },
    { value: "pie", icon: IconChartPie, label: t("Pie") },
    { value: "donut", icon: IconChartDonut, label: t("Donut") },
    { value: "number", icon: IconHash, label: t("Number") },
  ];

  let body: React.ReactNode;
  if (chartType === "number") {
    body = (
      <div className={classes.bigNumber} data-testid="chart-number">
        <div className={classes.bigValue}>{formatValue(total, i18n.language)}</div>
        <Text size="sm" c="dimmed">
          {caption}
          {xProp ? ` · ${xProp.name}` : ""}
        </Text>
      </div>
    );
  } else if (!xProp) {
    body = <div className={classes.empty}>{t("Pick a property to group the rows by.")}</div>;
  } else if (rows.length === 0 && !query.isLoading) {
    body = <div className={classes.empty}>{t("No rows yet")}</div>;
  } else if (chartType === "pie" || chartType === "donut") {
    body = <PieChart points={points} donut={chartType === "donut"} locale={i18n.language} total={total} />;
  } else if (chartType === "line") {
    body = <LineChart points={points} showValues={showValues} locale={i18n.language} />;
  } else {
    body = <BarChart points={points} showValues={showValues} locale={i18n.language} />;
  }

  return (
    <div className={classes.root} data-standalone={!embedded || undefined} data-testid="chart-view">
      <div className={classes.header}>
        {editable ? (
          <>
            <SegmentedControl
              size="xs"
              value={chartType}
              onChange={(v) => patch({ chartType: v })}
              data={typeOptions.map((o) => ({
                value: o.value,
                label: (
                  <Tooltip label={o.label}>
                    <span style={{ display: "inline-flex" }} aria-label={o.label}>
                      <o.icon size={14} />
                    </span>
                  </Tooltip>
                ),
              }))}
            />
            <Select
              size="xs"
              w={170}
              placeholder={t("Group by…")}
              value={xProp?.id ?? null}
              onChange={(v) => patch({ chartXPropertyId: v ?? null })}
              data={base.properties.filter((p) => GROUPABLE_TYPES.has(p.type)).map((p) => ({ value: p.id, label: p.name || t("Untitled") }))}
              clearable
              searchable
            />
            <Select
              size="xs"
              w={170}
              value={yProp?.id ?? "__count"}
              onChange={(v) => patch({ chartYPropertyId: !v || v === "__count" ? null : v })}
              data={[
                { value: "__count", label: t("Count") },
                ...base.properties.filter((p) => NUMERIC_TYPES.has(p.type)).map((p) => ({ value: p.id, label: p.name || t("Untitled") })),
              ]}
            />
            {yProp && (
              <Select
                size="xs"
                w={110}
                value={aggregate}
                onChange={(v) => v && patch({ chartAggregate: v })}
                data={(["sum", "avg", "min", "max"] as ChartAggregate[]).map((a) => ({ value: a, label: aggregateLabel[a] }))}
              />
            )}
            {xProp && DATE_TYPES.has(xProp.type) && (
              <Select
                size="xs"
                w={110}
                value={dateBucket}
                onChange={(v) => v && patch({ chartDateBucket: v })}
                data={[
                  { value: "day", label: t("Day") },
                  { value: "week", label: t("Week") },
                  { value: "month", label: t("Month") },
                  { value: "year", label: t("Year") },
                ]}
              />
            )}
            {chartType !== "number" && chartType !== "pie" && chartType !== "donut" && (
              <Switch size="xs" label={t("Values")} checked={showValues} onChange={(e) => patch({ chartShowValues: e.currentTarget.checked })} />
            )}
          </>
        ) : (
          <Text size="xs" c="dimmed">
            {caption}
            {xProp ? ` · ${xProp.name}` : ""}
          </Text>
        )}
        {chartType !== "number" && xProp && (
          <Switch size="xs" label={t("Table")} checked={showTable} onChange={(e) => setShowTable(e.currentTarget.checked)} ml="auto" />
        )}
      </div>
      <div className={classes.plot}>{body}</div>
      {showTable && xProp && chartType !== "number" && (
        <Table withTableBorder={false} highlightOnHover fz="sm" data-testid="chart-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{xProp.name}</Table.Th>
              <Table.Th ta="right">{caption}</Table.Th>
              <Table.Th ta="right">{t("Rows")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {points.map((p) => (
              <Table.Tr key={p.key}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <span className={classes.dot} style={{ background: p.color }} />
                    {p.label}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">{formatValue(p.value, i18n.language)}</Table.Td>
                <Table.Td ta="right">{p.count}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}
