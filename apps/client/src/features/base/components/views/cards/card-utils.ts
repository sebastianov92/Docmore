import {
  IBase,
  IBaseProperty,
  IBaseRow,
  IBaseView,
} from "@/features/base/types/base.types";
import { getSystemAccessor } from "@/features/base/hooks/use-base-table";

// Properties a card shows, in the view's order, honouring the view's
// hidden / visible lists. The primary property is the card title.
export function cardProperties(
  base: IBase,
  view: IBaseView | undefined,
  max = 6,
): IBaseProperty[] {
  const config = view?.config ?? {};
  const hidden = new Set(config.hiddenPropertyIds ?? []);
  const visible = config.visiblePropertyIds
    ? new Set(config.visiblePropertyIds)
    : null;
  const byId = new Map(base.properties.map((p) => [p.id, p]));
  const ordered: IBaseProperty[] = [];
  for (const id of config.propertyOrder ?? []) {
    const p = byId.get(id);
    if (p) ordered.push(p);
  }
  for (const p of base.properties) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered
    .filter((p) => !p.isPrimary)
    .filter((p) => !hidden.has(p.id))
    .filter((p) => (visible ? visible.has(p.id) : true))
    .slice(0, max);
}

export function cellValue(row: IBaseRow, property: IBaseProperty): unknown {
  const accessor = getSystemAccessor(property.type);
  return accessor ? accessor(row) : (row.cells ?? {})[property.id];
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function rowTitle(row: IBaseRow, primary: IBaseProperty | undefined): string {
  if (!primary) return "";
  const v = (row.cells ?? {})[primary.id];
  return typeof v === "string" ? v.trim() : "";
}

// First image attached under a file property; used as a gallery cover.
export function coverImageUrl(row: IBaseRow, property: IBaseProperty | undefined): string | null {
  if (!property) return null;
  const files = (row.cells ?? {})[property.id];
  if (!Array.isArray(files)) return null;
  for (const f of files as Array<{ id?: string; fileName?: string; mimeType?: string; url?: string }>) {
    const mime = f?.mimeType ?? "";
    const name = f?.fileName ?? "";
    const looksImage = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
    if (!looksImage || !f.id) continue;
    return f.url ?? `/api/files/${f.id}/${encodeURIComponent(name)}`;
  }
  return null;
}
