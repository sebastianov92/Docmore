import { FormCondition } from "@/features/base/types/base.types";

// Mirror of the server's rule: a field shows when another answer matches.
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function conditionHolds(cond: { propertyId: string; op: string; value?: unknown } | null | undefined, cells: Record<string, unknown>): boolean {
  if (!cond) return true;
  const v = cells?.[cond.propertyId];
  switch (cond.op) {
    case "isEmpty":
      return isBlank(v);
    case "isNotEmpty":
      return !isBlank(v);
    case "eq":
      if (Array.isArray(v)) return v.length === 1 && String(v[0]) === String(cond.value);
      if (typeof v === "boolean" || typeof cond.value === "boolean") return String(v) === String(cond.value);
      return !isBlank(v) && String(v) === String(cond.value);
    case "neq":
      if (Array.isArray(v)) return !(v.length === 1 && String(v[0]) === String(cond.value));
      return String(v ?? "") !== String(cond.value ?? "");
    case "contains":
      return !isBlank(v) && String(v).toLowerCase().includes(String(cond.value ?? "").toLowerCase());
    case "any": {
      const wanted = Array.isArray(cond.value) ? cond.value.map(String) : [String(cond.value)];
      const have = Array.isArray(v) ? v.map(String) : isBlank(v) ? [] : [String(v)];
      return have.some((x) => wanted.includes(x));
    }
    default:
      return true;
  }
}

export function visibleFieldIds(fields: { propertyId: string; showIf?: { propertyId: string; op: string; value?: unknown } | null }[], cells: Record<string, unknown>): Set<string> {
  const visible = new Set<string>();
  const byId = new Map(fields.map((f) => [f.propertyId, f]));
  const check = (id: string, depth: number): boolean => {
    if (visible.has(id)) return true;
    const f = byId.get(id);
    if (!f) return false;
    if (!f.showIf || depth > 10) {
      visible.add(id);
      return true;
    }
    const parentVisible = byId.has(f.showIf.propertyId) ? check(f.showIf.propertyId, depth + 1) : true;
    const ok = parentVisible && conditionHolds(f.showIf, cells);
    if (ok) visible.add(id);
    return ok;
  };
  for (const f of fields) check(f.propertyId, 0);
  return visible;
}
