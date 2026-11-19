import {
  IBaseProperty,
  IBaseRow,
  RowReferences,
  SelectTypeOptions,
} from "@/features/base/types/base.types";

// Fixed categorical order (validated for CVD separation and contrast on
// both surfaces); an 8th category folds into "Other".
export const CATEGORICAL = ["#228be6", "#e8590c", "#0ca678", "#ae3ec9", "#66a80f", "#1098ad", "#d6336c"];
export const OTHER_COLOR = "#868e96";
export const SINGLE_HUE = "#228be6";
const CHOICE_HEX: Record<string, string> = {
  gray: "#868e96",
  red: "#e03131",
  pink: "#d6336c",
  grape: "#ae3ec9",
  violet: "#7048e8",
  indigo: "#4263eb",
  blue: "#228be6",
  cyan: "#1098ad",
  teal: "#0ca678",
  green: "#2f9e44",
  lime: "#66a80f",
  yellow: "#e67700",
  orange: "#e8590c",
};

export type ChartType = "bar" | "line" | "pie" | "donut" | "number";
export type ChartAggregate = "count" | "sum" | "avg" | "min" | "max";
export type DateBucket = "day" | "week" | "month" | "year";

export type Bucket = { key: string; label: string; color: string; rows: IBaseRow[]; sortKey?: number };
export type ChartPoint = { key: string; label: string; color: string; value: number | null; count: number };

export const GROUPABLE_TYPES = new Set([
  "select",
  "status",
  "multiSelect",
  "checkbox",
  "date",
  "createdAt",
  "lastEditedAt",
  "person",
  "lastEditedBy",
  "relation",
  "text",
  "url",
  "email",
  "phone",
  "formula",
  "number",
  "id",
]);
export const NUMERIC_TYPES = new Set(["number", "id", "rollup", "formula"]);
export const DATE_TYPES = new Set(["date", "createdAt", "lastEditedAt"]);

export type BucketLabels = { noValue: string; yes: string; no: string; other: string; all: string };

function startOfBucket(d: Date, bucket: DateBucket): Date {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (bucket === "day") return day;
  if (bucket === "week") {
    const shift = (day.getDay() + 6) % 7; // Monday first
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() - shift);
  }
  if (bucket === "month") return new Date(day.getFullYear(), day.getMonth(), 1);
  return new Date(day.getFullYear(), 0, 1);
}

function bucketLabel(d: Date, bucket: DateBucket, locale: string): string {
  if (bucket === "day" || bucket === "week") return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
  if (bucket === "month") return d.toLocaleDateString(locale, { month: "short", year: "2-digit" });
  return String(d.getFullYear());
}

function systemValue(row: IBaseRow, property: IBaseProperty): unknown {
  switch (property.type) {
    case "createdAt":
      return row.createdAt;
    case "lastEditedAt":
      return row.updatedAt;
    case "lastEditedBy":
      return row.lastUpdatedById;
    case "id":
      return row.rowNo;
    default:
      return row.cells?.[property.id];
  }
}

// Splits rows into the categories of one property. Choice properties keep
// their own colors and order; dates are bucketed; everything else is
// counted by distinct value, the long tail folded into "Other".
export function bucketRows(
  rows: IBaseRow[],
  property: IBaseProperty | undefined,
  opts: { references: RowReferences; dateBucket: DateBucket; locale: string; labels: BucketLabels },
): Bucket[] {
  const { labels } = opts;
  if (!property) return [{ key: "__all", label: labels.all, color: SINGLE_HUE, rows }];

  if (property.type === "select" || property.type === "status" || property.type === "multiSelect") {
    const typeOptions = (property.typeOptions ?? {}) as Partial<SelectTypeOptions>;
    const choices = typeOptions.choices ?? [];
    const order = (typeOptions.choiceOrder ?? []).filter((id) => choices.some((c) => c.id === id));
    const ordered = [...order, ...choices.filter((c) => !order.includes(c.id)).map((c) => c.id)];
    const byId = new Map(choices.map((c) => [c.id, c]));
    const buckets = new Map<string, Bucket>();
    ordered.forEach((id, i) => {
      const c = byId.get(id)!;
      buckets.set(id, { key: id, label: c.name, color: CHOICE_HEX[c.color] ?? CATEGORICAL[i % CATEGORICAL.length], rows: [] });
    });
    const none: Bucket = { key: "__none", label: labels.noValue, color: OTHER_COLOR, rows: [] };
    for (const row of rows) {
      const value = row.cells?.[property.id];
      const ids = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      let placed = false;
      for (const id of ids) {
        const b = buckets.get(id as string);
        if (b) {
          b.rows.push(row);
          placed = true;
        }
      }
      if (!placed) none.rows.push(row);
    }
    const out = [...buckets.values()];
    if (none.rows.length) out.push(none);
    return out;
  }

  if (property.type === "checkbox") {
    const yes: Bucket = { key: "yes", label: labels.yes, color: CATEGORICAL[2], rows: [] };
    const no: Bucket = { key: "no", label: labels.no, color: OTHER_COLOR, rows: [] };
    for (const row of rows) (row.cells?.[property.id] === true ? yes : no).rows.push(row);
    return [yes, no];
  }

  if (DATE_TYPES.has(property.type)) {
    const buckets = new Map<string, Bucket>();
    const none: Bucket = { key: "__none", label: labels.noValue, color: OTHER_COLOR, rows: [] };
    for (const row of rows) {
      const raw = systemValue(row, property);
      const d = typeof raw === "string" && raw ? new Date(raw) : null;
      if (!d || Number.isNaN(d.getTime())) {
        none.rows.push(row);
        continue;
      }
      const start = startOfBucket(d, opts.dateBucket);
      const key = start.toISOString();
      const b = buckets.get(key) ?? {
        key,
        label: bucketLabel(start, opts.dateBucket, opts.locale),
        color: SINGLE_HUE,
        rows: [],
        sortKey: start.getTime(),
      };
      b.rows.push(row);
      buckets.set(key, b);
    }
    const out = [...buckets.values()].sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0));
    if (none.rows.length) out.push(none);
    return out;
  }

  // People, relations and free values: distinct values, top 7 + Other.
  const nameOf = (v: string): string => {
    if (property.type === "person" || property.type === "lastEditedBy") return opts.references.users?.[v]?.name || v;
    if (property.type === "relation") return opts.references.rows?.[v]?.title || v;
    return v;
  };
  const buckets = new Map<string, Bucket>();
  const none: Bucket = { key: "__none", label: labels.noValue, color: OTHER_COLOR, rows: [] };
  for (const row of rows) {
    const raw = systemValue(row, property);
    const values = Array.isArray(raw)
      ? raw.map(String)
      : raw === null || raw === undefined || raw === ""
        ? []
        : [String(raw)];
    if (values.length === 0) {
      none.rows.push(row);
      continue;
    }
    for (const v of values) {
      const b = buckets.get(v) ?? { key: v, label: nameOf(v), color: SINGLE_HUE, rows: [] };
      b.rows.push(row);
      buckets.set(v, b);
    }
  }
  let out = [...buckets.values()];
  const numeric = property.type === "number" || property.type === "id";
  out.sort((a, b) => (numeric ? Number(a.key) - Number(b.key) : b.rows.length - a.rows.length || a.label.localeCompare(b.label)));
  if (out.length > CATEGORICAL.length) {
    const head = out.slice(0, CATEGORICAL.length);
    const tail = out.slice(CATEGORICAL.length);
    const other: Bucket = { key: "__other", label: labels.other, color: OTHER_COLOR, rows: tail.flatMap((b) => b.rows) };
    out = [...head, other];
  }
  out.forEach((b, i) => {
    if (b.key !== "__other") b.color = CATEGORICAL[i % CATEGORICAL.length];
  });
  if (none.rows.length) out.push(none);
  return out;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function aggregateRows(rows: IBaseRow[], property: IBaseProperty | undefined, agg: ChartAggregate): number | null {
  if (agg === "count" || !property) return rows.length;
  const values = rows
    .map((r) => toNumber(property.type === "id" ? r.rowNo : r.cells?.[property.id]))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return values.length;
  }
}

export function formatValue(v: number | null, locale: string): string {
  if (v === null) return "–";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
}

// A round upper bound for the value axis (1, 2, 5 × 10^k).
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}
