import { BaseProperty, BaseRow } from '@docmost/db/types/entity.types';

// Evaluates a view-style filter tree against one row in memory (the SQL
// engine does the same for lists; automations judge a single row).
type Cond = { propertyId: string; op: string; value?: unknown };
type Group = { op: 'and' | 'or'; children: Array<Cond | Group> };

export function cellOf(row: BaseRow, property: BaseProperty | undefined): unknown {
  if (!property) return undefined;
  switch (property.type) {
    case 'createdAt':
      return row.createdAt;
    case 'lastEditedAt':
      return row.updatedAt;
    case 'lastEditedBy':
      return row.lastUpdatedById;
    case 'id':
      return row.rowNo;
    default:
      return ((row.cells ?? {}) as Record<string, unknown>)[property.id];
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asDay(v: unknown): number | null {
  if (v instanceof Date) return Math.floor(v.getTime() / 86_400_000);
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 86_400_000);
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined || v === '') return [];
  return [String(v)];
}

export function matchesCondition(cond: Cond, row: BaseRow, properties: BaseProperty[]): boolean {
  const property = properties.find((p) => p.id === cond.propertyId);
  const value = cellOf(row, property);
  const want = cond.value;
  switch (cond.op) {
    case 'isEmpty':
      return isEmpty(value);
    case 'isNotEmpty':
      return !isEmpty(value);
    case 'eq':
      if (typeof value === 'boolean' || typeof want === 'boolean') return Boolean(value) === Boolean(want);
      if (Array.isArray(value)) return asList(value).join(',') === asList(want).join(',');
      return String(value ?? '').toLowerCase() === String(want ?? '').toLowerCase();
    case 'neq':
      return !matchesCondition({ ...cond, op: 'eq' }, row, properties);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(value) ?? asDay(value);
      const b = asNumber(want) ?? asDay(want);
      if (a === null || b === null) return false;
      return cond.op === 'gt' ? a > b : cond.op === 'gte' ? a >= b : cond.op === 'lt' ? a < b : a <= b;
    }
    case 'contains':
      return String(value ?? '').toLowerCase().includes(String(want ?? '').toLowerCase());
    case 'ncontains':
      return !String(value ?? '').toLowerCase().includes(String(want ?? '').toLowerCase());
    case 'startsWith':
      return String(value ?? '').toLowerCase().startsWith(String(want ?? '').toLowerCase());
    case 'endsWith':
      return String(value ?? '').toLowerCase().endsWith(String(want ?? '').toLowerCase());
    case 'before':
    case 'after':
    case 'onOrBefore':
    case 'onOrAfter': {
      const a = asDay(value);
      const b = asDay(want);
      if (a === null || b === null) return false;
      return cond.op === 'before' ? a < b : cond.op === 'after' ? a > b : cond.op === 'onOrBefore' ? a <= b : a >= b;
    }
    case 'any': {
      const have = new Set(asList(value));
      return asList(want).some((w) => have.has(w));
    }
    case 'none': {
      const have = new Set(asList(value));
      return !asList(want).some((w) => have.has(w));
    }
    case 'all': {
      const have = new Set(asList(value));
      return asList(want).every((w) => have.has(w));
    }
    default:
      return false;
  }
}

export function matchesFilter(node: Cond | Group | null | undefined, row: BaseRow, properties: BaseProperty[]): boolean {
  if (!node) return true;
  if ('children' in node) {
    if (node.children.length === 0) return true;
    return node.op === 'or'
      ? node.children.some((c) => matchesFilter(c, row, properties))
      : node.children.every((c) => matchesFilter(c, row, properties));
  }
  return matchesCondition(node, row, properties);
}

// {{now}}, {{today}}, {{actor}}, {{title}} and {{row.<propertyId>}} inside
// cell values and messages; a value that is exactly one {{row.x}} keeps the
// cell's own type.
export function renderTemplate(
  value: unknown,
  ctx: { row: BaseRow; properties: BaseProperty[]; actorId: string | null; title: string },
): unknown {
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (typeof value !== 'string') return value;
  const whole = /^\{\{\s*row\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(value);
  if (whole) return cellOf(ctx.row, ctx.properties.find((p) => p.id === whole[1]));
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'now') return new Date().toISOString();
    if (key === 'today') return new Date().toISOString().slice(0, 10);
    if (key === 'actor') return ctx.actorId ?? '';
    if (key === 'title') return ctx.title;
    if (key.startsWith('row.')) {
      const v = cellOf(ctx.row, ctx.properties.find((p) => p.id === key.slice(4)));
      return Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
    }
    return '';
  });
}
