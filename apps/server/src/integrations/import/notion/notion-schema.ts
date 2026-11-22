import { plainText } from './notion-html';

// Something that did not come over as it was. A code the screen puts into
// words in the reader's language, with the name it is about.
export interface ImportNote {
  code: string;
  name?: string;
  detail?: string;
  count?: number;
}

// A Notion data source (a table of a database) to a base: its columns, the
// value of each cell and its views. Pure: no network, no database.

export type BaseType =
  | 'text'
  | 'longText'
  | 'number'
  | 'select'
  | 'status'
  | 'multiSelect'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'location'
  | 'relation';

export interface Choice {
  id: string;
  name: string;
  color: string;
  category?: 'todo' | 'inProgress' | 'complete';
}

export interface MappedProperty {
  // the Notion column
  notionId: string;
  notionName: string;
  notionType: string;
  // the base column; null = the column does not come over
  type: BaseType | null;
  name: string;
  typeOptions?: Record<string, unknown>;
  primary?: boolean;
  // Notion option id or name -> choice id here
  choiceIds?: Map<string, string>;
  // relation: the Notion data source the rows point to
  relationTarget?: string;
  // dates with an end get a second column for it
  endOf?: string;
}

const COLORS: Record<string, string> = {
  default: 'gray',
  gray: 'gray',
  brown: 'orange',
  orange: 'orange',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  purple: 'violet',
  pink: 'pink',
  red: 'red',
};

const CURRENCY: Record<string, string> = {
  dollar: '$',
  canadian_dollar: 'CA$',
  australian_dollar: 'A$',
  singapore_dollar: 'S$',
  euro: '€',
  pound: '£',
  yen: '¥',
  yuan: '¥',
  won: '₩',
  rupee: '₹',
  real: 'R$',
  ruble: '₽',
  franc: 'CHF',
  mexican_peso: 'MX$',
  argentine_peso: 'AR$',
  colombian_peso: 'CO$',
  chilean_peso: 'CL$',
  peruvian_sol: 'S/',
};

// `prefix` keeps the ids of one column apart from every other column's.
function choicesOf(options: any[], prefix: string, groups?: any[]): { choices: Choice[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const categoryOf = new Map<string, Choice['category']>();
  (groups ?? []).forEach((group, index) => {
    // Notion's three groups come in order: to do, in progress, complete
    const name = String(group?.name ?? '').toLowerCase();
    const category: Choice['category'] =
      name.includes('progress') ? 'inProgress' : name.includes('complete') || name.includes('done') ? 'complete' : name.includes('to') ? 'todo' : index === 0 ? 'todo' : index === (groups ?? []).length - 1 ? 'complete' : 'inProgress';
    for (const optionId of group?.option_ids ?? []) categoryOf.set(String(optionId), category);
  });
  const choices: Choice[] = [];
  const seen = new Set<string>();
  (options ?? []).forEach((option, index) => {
    const name = String(option?.name ?? '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const id = `${prefix}c${index + 1}`;
    const category = categoryOf.get(String(option?.id));
    choices.push({ id, name, color: COLORS[String(option?.color ?? 'default')] ?? 'gray', ...(category ? { category } : {}) });
    if (option?.id) ids.set(String(option.id), id);
    ids.set(name, id);
  });
  return { choices, ids };
}

// The value a formula or a rollup shows, whatever it is.
function shown(value: any): unknown {
  if (!value || typeof value !== 'object') return null;
  switch (value.type) {
    case 'string':
      return value.string ?? null;
    case 'number':
      return value.number ?? null;
    case 'boolean':
      return value.boolean ?? null;
    case 'date':
      return value.date?.start ?? null;
    case 'array':
      return (value.array ?? [])
        .map((item: any) => {
          const inner = item?.[item?.type];
          if (Array.isArray(inner)) return plainText(inner) || inner.map((x: any) => x?.name ?? '').filter(Boolean).join(', ');
          if (inner && typeof inner === 'object') return inner.name ?? inner.start ?? inner.string ?? inner.number ?? '';
          return inner ?? '';
        })
        .filter((part: unknown) => part !== '' && part !== null)
        .join(', ');
    default:
      return null;
  }
}

// What kind of value a computed column holds, from the rows that have one.
function computedType(name: string, rows: Array<Record<string, any>>): BaseType {
  for (const row of rows) {
    const value = row[name];
    const inner = value?.[value?.type];
    if (!inner || inner[inner.type] === null || inner[inner.type] === undefined) continue;
    if (inner.type === 'number') return 'number';
    if (inner.type === 'boolean') return 'checkbox';
    if (inner.type === 'date') return 'date';
    return 'text';
  }
  return 'text';
}

const hasTime = (value: unknown) => typeof value === 'string' && value.includes('T');

// The columns of a base for a Notion schema. `rows` are the property maps
// of the pages (to see which dates carry a time or an end, and what the
// computed columns hold); `notes` collects what does not come over.
export function mapSchema(schema: Record<string, any>, rows: Array<Record<string, any>>, notes: ImportNote[]): MappedProperty[] {
  const out: MappedProperty[] = [];
  const names = new Set<string>();
  const unique = (name: string) => {
    let candidate = name.trim() || 'Untitled';
    for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
    names.add(candidate.toLowerCase());
    return candidate;
  };
  // the title first, then the rest as Notion gives them
  const entries = Object.entries(schema ?? {}).sort(([, a], [, b]) => Number(b?.type === 'title') - Number(a?.type === 'title'));
  for (const [position, [key, config]] of entries.entries()) {
    const notionName = String(config?.name ?? key);
    const notionType = String(config?.type ?? '');
    const base = { notionId: String(config?.id ?? key), notionName, notionType };
    const add = (type: BaseType | null, extra: Partial<MappedProperty> = {}) => {
      const mapped: MappedProperty = { ...base, type, name: type ? unique(notionName) : notionName, ...extra };
      out.push(mapped);
      return mapped;
    };
    const dateColumns = (values: unknown[], ends: unknown[]) => {
      const start = add('date', { typeOptions: { includeTime: values.some(hasTime) } });
      if (ends.some(Boolean)) {
        out.push({ ...base, type: 'date', name: unique(`${notionName} (end)`), typeOptions: { includeTime: ends.some(hasTime) }, endOf: start.name });
      }
    };
    switch (notionType) {
      case 'title':
        add('text', { primary: true });
        break;
      case 'rich_text':
        add('text');
        break;
      case 'number': {
        const format = String(config.number?.format ?? 'number');
        const typeOptions =
          format === 'percent' ? { format: 'percent' } : CURRENCY[format] ? { format: 'currency', currencySymbol: CURRENCY[format] } : { format: 'plain' };
        add('number', { typeOptions });
        break;
      }
      case 'select':
      case 'multi_select':
      case 'status': {
        const { choices, ids } = choicesOf(config[notionType]?.options ?? [], `p${position}`, notionType === 'status' ? config.status?.groups : undefined);
        add(notionType === 'select' ? 'select' : notionType === 'status' ? 'status' : 'multiSelect', {
          typeOptions: { choices, choiceOrder: choices.map((c) => c.id) },
          choiceIds: ids,
        });
        break;
      }
      case 'date':
        dateColumns(
          rows.map((row) => row[notionName]?.date?.start),
          rows.map((row) => row[notionName]?.date?.end),
        );
        break;
      case 'created_time':
      case 'last_edited_time':
        add('date', { typeOptions: { includeTime: true } });
        break;
      case 'checkbox':
        add('checkbox');
        break;
      case 'url':
        add('url');
        break;
      case 'email':
        add('email');
        break;
      case 'phone_number':
        add('phone');
        break;
      case 'place':
        add('location');
        break;
      case 'people':
      case 'created_by':
      case 'last_edited_by':
        add('text');
        notes.push({ code: 'people_as_names', name: notionName });
        break;
      case 'unique_id':
        add('text');
        break;
      case 'formula': {
        const type = computedType(notionName, rows);
        add(type, type === 'date' ? { typeOptions: { includeTime: rows.some((row) => hasTime(row[notionName]?.formula?.date?.start)) } } : {});
        notes.push({ code: 'formula_as_values', name: notionName });
        break;
      }
      case 'rollup':
        add(computedType(notionName, rows) === 'number' ? 'number' : 'text');
        notes.push({ code: 'rollup_as_values', name: notionName });
        break;
      case 'relation': {
        const target = config.relation?.data_source_id ?? config.relation?.database_id;
        add('relation', { relationTarget: target ? String(target).replace(/-/g, '').toLowerCase() : undefined });
        break;
      }
      case 'files':
        add(null);
        notes.push({ code: 'files_column', name: notionName });
        break;
      default:
        add(null);
        notes.push({ code: 'column_type', name: notionName, detail: notionType || 'unknown' });
        break;
    }
  }
  if (!out.some((p) => p.primary)) out.unshift({ notionId: 'title', notionName: 'Name', notionType: 'title', type: 'text', name: unique('Name'), primary: true });
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d(][\d\s().-]{3,30}$/;

function isUrl(value: string): boolean {
  try {
    return Boolean(new URL(value));
  } catch {
    return false;
  }
}

function peopleNames(people: any[]): string {
  return (people ?? [])
    .map((person) => person?.name ?? person?.person?.email ?? '')
    .filter(Boolean)
    .join(', ');
}

// The cell of one column for one Notion page; undefined = leave it empty.
// A relation gives the Notion ids of the pages it points to: the caller
// turns them into rows once every row exists.
export function cellOf(property: MappedProperty, value: any): unknown {
  if (!property.type || !value) return undefined;
  const inner = value[value.type];
  switch (property.notionType) {
    case 'title':
    case 'rich_text': {
      const text = plainText(inner).trim();
      return text || undefined;
    }
    case 'number':
      return typeof inner === 'number' ? inner : undefined;
    case 'select':
    case 'status': {
      const id = property.choiceIds?.get(String(inner?.id)) ?? property.choiceIds?.get(String(inner?.name));
      return id ?? undefined;
    }
    case 'multi_select': {
      const ids = (inner ?? [])
        .map((option: any) => property.choiceIds?.get(String(option?.id)) ?? property.choiceIds?.get(String(option?.name)))
        .filter(Boolean);
      return ids.length ? ids : undefined;
    }
    case 'date': {
      const raw = property.endOf ? inner?.end : inner?.start;
      return dateCell(raw);
    }
    case 'created_time':
    case 'last_edited_time':
      return dateCell(inner);
    case 'checkbox':
      return inner === true ? true : undefined;
    case 'url':
      return typeof inner === 'string' && isUrl(inner.trim()) ? inner.trim() : undefined;
    case 'email':
      return typeof inner === 'string' && EMAIL.test(inner.trim()) ? inner.trim() : undefined;
    case 'phone_number': {
      const phone = typeof inner === 'string' ? inner.trim() : '';
      return PHONE.test(phone) && phone.replace(/\D/g, '').length >= 4 ? phone : undefined;
    }
    case 'place': {
      if (!inner) return undefined;
      const name = String(inner.name ?? inner.address ?? '').trim().slice(0, 300);
      const lat = typeof inner.lat === 'number' ? inner.lat : null;
      const lng = typeof inner.lon === 'number' ? inner.lon : null;
      if (!name && (lat === null || lng === null)) return undefined;
      return { name, address: inner.address ? String(inner.address).slice(0, 500) : null, lat, lng };
    }
    case 'people':
      return peopleNames(inner) || undefined;
    case 'created_by':
    case 'last_edited_by':
      return (inner?.name as string | undefined) || undefined;
    case 'unique_id': {
      if (typeof inner?.number !== 'number') return undefined;
      return inner.prefix ? `${inner.prefix}-${inner.number}` : String(inner.number);
    }
    case 'formula':
    case 'rollup': {
      const result = shown(inner);
      if (result === null || result === undefined || result === '') return undefined;
      if (property.type === 'number') return typeof result === 'number' ? result : undefined;
      if (property.type === 'checkbox') return result === true ? true : undefined;
      if (property.type === 'date') return dateCell(result);
      return String(result).slice(0, 2000);
    }
    case 'relation':
      return (inner ?? []).map((ref: any) => String(ref?.id ?? '').replace(/-/g, '').toLowerCase()).filter(Boolean);
    default:
      return undefined;
  }
}

// Notion writes a day as 2026-11-22 and a moment with its offset.
function dateCell(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface MappedView {
  name: string;
  type: 'table' | 'kanban' | 'calendar' | 'timeline' | 'gallery' | 'list';
  // by column name here; the caller turns names into ids
  config: {
    groupBy?: string;
    calendarBy?: string;
    timelineStart?: string;
    timelineEnd?: string;
    cover?: string;
    cardSize?: 'small' | 'medium' | 'large';
    visible?: string[];
    hidden?: string[];
    sorts?: Array<{ property: string; direction: 'asc' | 'desc' }>;
  };
}

const VIEW_TYPES: Record<string, MappedView['type']> = {
  table: 'table',
  board: 'kanban',
  calendar: 'calendar',
  timeline: 'timeline',
  gallery: 'gallery',
  list: 'list',
};

const VIEW_NAMES: Record<MappedView['type'], string> = {
  table: 'Table',
  kanban: 'Board',
  calendar: 'Calendar',
  timeline: 'Timeline',
  gallery: 'Gallery',
  list: 'List',
};

// A Notion view as a view of the base. Columns are named by Notion id or
// name there; here by the name of the column they became.
export function mapView(view: any, properties: MappedProperty[], notes: ImportNote[]): MappedView | null {
  const type = VIEW_TYPES[String(view?.type ?? '')];
  const given = String(view?.name ?? '').trim();
  // Notion hands unnamed views over as "Untitled": here they are called after what they are
  const name = given && given.toLowerCase() !== 'untitled' ? given : VIEW_NAMES[type ?? 'table'];
  if (!type) {
    notes.push({ code: 'view_type', name, detail: String(view?.type ?? 'unknown') });
    return null;
  }
  const column = (ref: unknown): MappedProperty | undefined => {
    if (typeof ref !== 'string' || !ref) return undefined;
    return (
      properties.find((p) => p.type && !p.endOf && p.notionId === ref) ??
      properties.find((p) => p.type && !p.endOf && p.notionName === ref)
    );
  };
  const config: MappedView['config'] = {};
  const settings = (view?.configuration ?? {}) as Record<string, any>;

  const listed = Array.isArray(settings.properties) ? settings.properties : [];
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const entry of listed) {
    const found = column(entry?.property_id);
    if (!found) continue;
    (entry?.visible === false ? hidden : visible).push(found.name);
  }
  if (visible.length) config.visible = visible;
  if (hidden.length) config.hidden = hidden;

  if (type === 'kanban') {
    const by = column(settings.group_by?.property_id);
    if (by && (by.type === 'select' || by.type === 'status')) config.groupBy = by.name;
    else {
      const fallback = properties.find((p) => p.type === 'status') ?? properties.find((p) => p.type === 'select');
      if (!fallback) {
        notes.push({ code: 'board_as_table', name });
        return { name, type: 'table', config };
      }
      config.groupBy = fallback.name;
    }
  }
  if (type === 'calendar') {
    const by = column(settings.date_property_id);
    if (by?.type === 'date') config.calendarBy = by.name;
  }
  if (type === 'timeline') {
    const start = column(settings.date_property_id);
    const end = column(settings.end_date_property_id);
    if (start?.type === 'date') {
      config.timelineStart = start.name;
      // a Notion date with an end became two columns
      const split = properties.find((p) => p.endOf === start.name);
      if (end?.type === 'date') config.timelineEnd = end.name;
      else if (split) config.timelineEnd = split.name;
    }
  }
  if (type === 'gallery') {
    const size = settings.cover_size;
    if (size === 'small' || size === 'medium' || size === 'large') config.cardSize = size;
  }

  const sorts = Array.isArray(view?.sorts) ? view.sorts : [];
  const mappedSorts = sorts
    .map((sort: any) => {
      const found = column(sort?.property);
      return found ? { property: found.name, direction: sort?.direction === 'descending' ? ('desc' as const) : ('asc' as const) } : null;
    })
    .filter(Boolean) as NonNullable<MappedView['config']['sorts']>;
  if (mappedSorts.length) config.sorts = mappedSorts;
  if (view?.filter) notes.push({ code: 'view_filter', name });
  return { name, type, config };
}
