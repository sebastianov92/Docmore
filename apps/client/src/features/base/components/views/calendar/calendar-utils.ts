import { IBaseProperty, IBaseRow } from "@/features/base/types/base.types";

export const DATE_LIKE_TYPES = ["date", "createdAt", "lastEditedAt"] as const;

export function isDateLike(property: IBaseProperty): boolean {
  return (DATE_LIKE_TYPES as readonly string[]).includes(property.type);
}

// The property a calendar places rows by: the configured one, else the
// first date-like property of the base.
export function resolveCalendarProperty(
  properties: IBaseProperty[],
  configuredId: string | undefined,
): IBaseProperty | undefined {
  const configured = configuredId
    ? properties.find((p) => p.id === configuredId && isDateLike(p))
    : undefined;
  return configured ?? properties.find(isDateLike);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

// Monday-first six-week grid that contains the month.
export function monthGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

// The date a row shows on: the cell for a date property, the row stamp for
// the system ones.
export function rowDate(row: IBaseRow, property: IBaseProperty): Date | null {
  let raw: unknown;
  if (property.type === "createdAt") raw = row.createdAt;
  else if (property.type === "lastEditedAt") raw = row.updatedAt;
  else raw = row.cells[property.id];
  if (typeof raw !== "string" || !raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function groupRowsByDay(rows: IBaseRow[], property: IBaseProperty): Map<string, IBaseRow[]> {
  const map = new Map<string, IBaseRow[]>();
  for (const row of rows) {
    const date = rowDate(row, property);
    if (!date) continue;
    const key = dayKey(date);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}
