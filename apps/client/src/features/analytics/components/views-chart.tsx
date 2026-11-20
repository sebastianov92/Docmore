import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { BarChart } from "@/features/base/components/views/chart/chart-svg";
import type { ChartPoint } from "@/features/base/components/views/chart/chart-data";
import { ViewsByDay } from "../services";

// Views per day over the period, gaps filled with zero.
export function ViewsChart({ byDay, days }: { byDay: ViewsByDay[]; days: number }) {
  const { i18n } = useTranslation();
  const points = useMemo<ChartPoint[]>(() => {
    const map = new Map(byDay.map((d) => [d.day, d]));
    const out: ChartPoint[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const row = map.get(key);
      out.push({
        key,
        label: d.toLocaleDateString(i18n.language, { day: "numeric", month: "short" }),
        color: "#228be6",
        value: row?.views ?? 0,
        count: row?.viewers ?? 0,
      });
    }
    // one bar per day up to 31 days; weekly buckets beyond that
    if (out.length <= 31) return out;
    const weekly: ChartPoint[] = [];
    for (let i = 0; i < out.length; i += 7) {
      const slice = out.slice(i, i + 7);
      weekly.push({ key: slice[0].key, label: slice[0].label, color: "#228be6", value: slice.reduce((a, p) => a + (p.value ?? 0), 0), count: slice.reduce((a, p) => a + p.count, 0) });
    }
    return weekly;
  }, [byDay, days, i18n.language]);
  return <BarChart points={points} showValues={points.length <= 14} locale={i18n.language} />;
}
