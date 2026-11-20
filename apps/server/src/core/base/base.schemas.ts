import { z } from 'zod';
import { baseChoiceIdSchema, basePropertyIdSchema } from './base-ids';

export const BasePropertyType = {
  TEXT: 'text',
  LONG_TEXT: 'longText',
  NUMBER: 'number',
  SELECT: 'select',
  STATUS: 'status',
  MULTI_SELECT: 'multiSelect',
  DATE: 'date',
  PERSON: 'person',
  FILE: 'file',
  PAGE: 'page',
  CHECKBOX: 'checkbox',
  URL: 'url',
  EMAIL: 'email',
  PHONE: 'phone',
  LOCATION: 'location',
  CONNECTED: 'connected',
  ID: 'id',
  RELATION: 'relation',
  ROLLUP: 'rollup',
  BUTTON: 'button',
  CREATED_AT: 'createdAt',
  LAST_EDITED_AT: 'lastEditedAt',
  LAST_EDITED_BY: 'lastEditedBy',
  FORMULA: 'formula',
} as const;

const SYSTEM_PROPERTY_TYPES: Set<string> = new Set([
  BasePropertyType.CREATED_AT,
  BasePropertyType.LAST_EDITED_AT,
  BasePropertyType.LAST_EDITED_BY,
  BasePropertyType.ID,
  BasePropertyType.ROLLUP,
  BasePropertyType.FORMULA,
]);

export function isSystemPropertyType(type: string): boolean {
  return SYSTEM_PROPERTY_TYPES.has(type);
}

export type BasePropertyTypeValue =
  (typeof BasePropertyType)[keyof typeof BasePropertyType];

export const BASE_PROPERTY_TYPES = Object.values(BasePropertyType);

/*
 * The subset of property types that users can convert TO via the
 * /bases/properties/update endpoint. Excludes system auto-types
 * (createdAt/lastEditedAt/lastEditedBy) and formula — those have their
 * own creation paths and are not valid one-click conversion targets.
 */
export const USER_PROPERTY_TYPES: readonly BasePropertyTypeValue[] =
  BASE_PROPERTY_TYPES.filter(
    (t) => !SYSTEM_PROPERTY_TYPES.has(t),
  ) as readonly BasePropertyTypeValue[];

// AI autofill: a prompt run over the row's other cells.
export const aiFillSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  autoUpdate: z.boolean().optional(),
  sourcePropertyIds: z.array(basePropertyIdSchema).max(50).optional(),
});

// A button cell runs an automation of this base.
export const buttonTypeOptionsSchema = z
  .object({
    label: z.string().trim().max(60).optional(),
    automationId: z.uuid().optional(),
  })
  .passthrough();

export const choiceSchema = z.object({
  id: baseChoiceIdSchema,
  name: z.string().min(1),
  color: z.string(),
  category: z.enum(['todo', 'inProgress', 'complete']).optional(),
});

export const selectTypeOptionsSchema = z
  .object({
    ai: aiFillSchema.optional(),
    choices: z.array(choiceSchema).default([]),
    choiceOrder: z.array(baseChoiceIdSchema).default([]),
    disableColors: z.boolean().optional(),
    defaultValue: z
      .union([baseChoiceIdSchema, z.array(baseChoiceIdSchema)])
      .nullable()
      .optional(),
  })
  .passthrough();

export const numberTypeOptionsSchema = z
  .object({
    ai: aiFillSchema.optional(),
    format: z
      .enum(['plain', 'currency', 'percent', 'progress'])
      .optional()
      .default('plain'),
    precision: z.number().int().min(0).max(10).optional(),
    currencySymbol: z.string().max(5).optional(),
    defaultValue: z.number().nullable().optional(),
  })
  .passthrough();

export const dateTypeOptionsSchema = z
  .object({
    dateFormat: z.string().optional(),
    timeFormat: z.enum(['12h', '24h']).optional(),
    includeTime: z.boolean().optional(),
    defaultValue: z.string().nullable().optional(),
  })
  .passthrough();

export const textTypeOptionsSchema = z
  .object({
    ai: aiFillSchema.optional(),
    richText: z.boolean().optional(),
    defaultValue: z.string().nullable().optional(),
  })
  .passthrough();

export const checkboxTypeOptionsSchema = z
  .object({
    ai: aiFillSchema.optional(),
    defaultValue: z.boolean().optional(),
  })
  .passthrough();

export const urlTypeOptionsSchema = z
  .object({
    defaultValue: z.string().nullable().optional(),
  })
  .passthrough();

export const emailTypeOptionsSchema = z
  .object({
    defaultValue: z.string().nullable().optional(),
  })
  .passthrough();

export const personTypeOptionsSchema = z
  .object({
    allowMultiple: z.boolean().default(true),
  })
  .passthrough();

export const emptyTypeOptionsSchema = z.object({}).passthrough();

// Relation: rows of another base (or this one); cell = array of row ids.
export const relationTypeOptionsSchema = z
  .object({
    targetPageId: z.uuid(),
    allowMultiple: z.boolean().optional(),
  })
  .passthrough();

// Rollup: an aggregate over the rows a relation points to, computed on read.
// Who may see a column.
export const PROPERTY_RESTRICTIONS = ['all', 'editors', 'admins'] as const;
export type PropertyRestriction = (typeof PROPERTY_RESTRICTIONS)[number];

export const ROLLUP_AGGREGATES = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'show',
] as const;
export const rollupTypeOptionsSchema = z
  .object({
    relationPropertyId: basePropertyIdSchema,
    targetPropertyId: basePropertyIdSchema.optional(),
    aggregate: z.enum(ROLLUP_AGGREGATES),
  })
  .passthrough();

// ID: a per-base number assigned on insert, shown with an optional prefix.
export const idTypeOptionsSchema = z
  .object({ prefix: z.string().max(20).optional() })
  .passthrough();

// AST is treated as an opaque JSON tree by the server at this layer — the
// shape is enforced at the formula package's parser, not at Zod. The Zod
// schema validates only the envelope so a malformed blob can't corrupt the
// column. Depth/content validation belongs to FormulaService.
export const formulaTypeOptionsSchema = z
  .object({
    source: z.string().min(1).max(8192),
    ast: z.any(),
    resultType: z.enum(['number', 'string', 'boolean', 'date', 'null']),
    dependencies: z.array(basePropertyIdSchema),
    astVersion: z.literal(1),
    formatOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const typeOptionsSchemaMap: Record<BasePropertyTypeValue, z.ZodType> = {
  [BasePropertyType.TEXT]: textTypeOptionsSchema,
  [BasePropertyType.LONG_TEXT]: textTypeOptionsSchema,
  [BasePropertyType.NUMBER]: numberTypeOptionsSchema,
  [BasePropertyType.SELECT]: selectTypeOptionsSchema,
  [BasePropertyType.STATUS]: selectTypeOptionsSchema,
  [BasePropertyType.MULTI_SELECT]: selectTypeOptionsSchema,
  [BasePropertyType.DATE]: dateTypeOptionsSchema,
  [BasePropertyType.PERSON]: personTypeOptionsSchema,
  [BasePropertyType.FILE]: emptyTypeOptionsSchema,
  [BasePropertyType.PAGE]: emptyTypeOptionsSchema,
  [BasePropertyType.CHECKBOX]: checkboxTypeOptionsSchema,
  [BasePropertyType.URL]: urlTypeOptionsSchema,
  [BasePropertyType.EMAIL]: emailTypeOptionsSchema,
  [BasePropertyType.PHONE]: textTypeOptionsSchema,
  [BasePropertyType.LOCATION]: emptyTypeOptionsSchema,
  [BasePropertyType.CONNECTED]: emptyTypeOptionsSchema,
  [BasePropertyType.ID]: idTypeOptionsSchema,
  [BasePropertyType.RELATION]: relationTypeOptionsSchema,
  [BasePropertyType.ROLLUP]: rollupTypeOptionsSchema,
  [BasePropertyType.BUTTON]: buttonTypeOptionsSchema,
  [BasePropertyType.CREATED_AT]: emptyTypeOptionsSchema,
  [BasePropertyType.LAST_EDITED_AT]: emptyTypeOptionsSchema,
  [BasePropertyType.LAST_EDITED_BY]: emptyTypeOptionsSchema,
  [BasePropertyType.FORMULA]: formulaTypeOptionsSchema,
};

export function validateTypeOptions(
  type: BasePropertyTypeValue,
  typeOptions: unknown,
): z.ZodSafeParseResult<unknown> {
  const schema = typeOptionsSchemaMap[type];
  if (!schema) {
    return { success: false, error: new z.ZodError([{ code: 'custom', message: `Unknown property type: ${type}`, path: ['type'] }]) } as z.ZodSafeParseError<unknown>;
  }
  return schema.safeParse(typeOptions ?? {});
}

export function parseTypeOptions(
  type: BasePropertyTypeValue,
  typeOptions: unknown,
): unknown {
  const result = validateTypeOptions(type, typeOptions);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

const cellValueSchemaMap: Partial<Record<BasePropertyTypeValue, z.ZodType>> = {
  [BasePropertyType.TEXT]: z.string(),
  [BasePropertyType.LONG_TEXT]: z.string().max(25_000),
  [BasePropertyType.NUMBER]: z.number(),
  [BasePropertyType.SELECT]: baseChoiceIdSchema,
  [BasePropertyType.STATUS]: baseChoiceIdSchema,
  [BasePropertyType.MULTI_SELECT]: z.array(baseChoiceIdSchema),
  [BasePropertyType.DATE]: z.string(),
  [BasePropertyType.PERSON]: z.union([z.uuid(), z.array(z.uuid())]),
  [BasePropertyType.FILE]: z.array(z.object({
    id: z.uuid(),
    fileName: z.string(),
    mimeType: z.string().optional(),
    fileSize: z.number().optional(),
    filePath: z.string().optional(),
  })),
  [BasePropertyType.PAGE]: z.uuid(),
  [BasePropertyType.CHECKBOX]: z.boolean(),
  [BasePropertyType.URL]: z.url(),
  [BasePropertyType.EMAIL]: z.email(),
  // digits with the usual separators; `+` only at the start
  [BasePropertyType.RELATION]: z.array(z.uuid()).max(200),
  [BasePropertyType.PHONE]: z
    .string()
    .trim()
    .regex(/^\+?[\d(][\d\s().-]{3,30}$/, 'Invalid phone number')
    .refine((v) => v.replace(/\D/g, '').length >= 4, 'Invalid phone number'),
  // A place: a name, an optional address and optional coordinates.
  [BasePropertyType.LOCATION]: z
    .object({
      name: z.string().trim().max(300),
      address: z.string().trim().max(500).nullable().optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    })
    .refine((v) => v.name.length > 0 || (typeof v.lat === 'number' && typeof v.lng === 'number'), 'A place needs a name or coordinates'),


  // A link to something outside (a pull request, an issue, a file) whose
  // details the server fetches and keeps fresh.
  [BasePropertyType.CONNECTED]: z.object({
    url: z.url().max(2000),
    title: z.string().max(500).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.string().max(100).nullable().optional(),
    statusColor: z.string().max(40).nullable().optional(),
    author: z.string().max(200).nullable().optional(),
    provider: z.string().max(60).nullable().optional(),
    providerIcon: z.string().max(60).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    fetchedAt: z.string().nullable().optional(),
    error: z.string().max(300).nullable().optional(),
    byUserId: z.string().nullable().optional(),
  }),
};

export interface ConnectedValue {
  url: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  statusColor?: string | null;
  author?: string | null;
  provider?: string | null;
  providerIcon?: string | null;
  metadata?: Record<string, unknown> | null;
  fetchedAt?: string | null;
  error?: string | null;
  byUserId?: string | null;
}

export function connectedToText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as ConnectedValue;
  if (!v.url) return '';
  const bits = [v.title, v.status ? `[${v.status}]` : null].filter(Boolean).join(' ');
  return bits ? `${bits} (${v.url})` : v.url;
}

export function parseConnectedText(text: string): ConnectedValue | null {
  const raw = String(text ?? '').trim();
  const m = /(https?:\/\/[^\s)]+)/i.exec(raw);
  return m ? { url: m[1] } : null;
}

export interface LocationValue {
  name: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
}

// "Quito", "Quito @ -0.18, -78.47", "-0.18, -78.47" or "Name | address".
export function parseLocationText(text: string): LocationValue | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const coords = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
  let name = raw;
  let address: string | null = null;
  let lat: number | null = null;
  let lng: number | null = null;
  const at = raw.split('@');
  if (at.length === 2 && coords.test(at[1])) {
    name = at[0].trim();
    const m = coords.exec(at[1])!;
    lat = Number(m[1]);
    lng = Number(m[2]);
  } else if (coords.test(raw)) {
    const m = coords.exec(raw)!;
    lat = Number(m[1]);
    lng = Number(m[2]);
    name = '';
  }
  const bar = name.split('|');
  if (bar.length === 2) {
    name = bar[0].trim();
    address = bar[1].trim() || null;
  }
  if (lat !== null && (lat < -90 || lat > 90 || lng === null || lng < -180 || lng > 180)) return null;
  const value: LocationValue = { name: name.slice(0, 300), address, lat, lng };
  return value.name || (lat !== null && lng !== null) ? value : null;
}

export function locationToText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as LocationValue;
  const name = String(v.name ?? '').trim();
  const coords = typeof v.lat === 'number' && typeof v.lng === 'number' ? `${v.lat}, ${v.lng}` : '';
  const address = v.address ? ` | ${v.address}` : '';
  if (name && coords) return `${name}${address} @ ${coords}`;
  return name ? `${name}${address}` : coords;
}

export function getCellValueSchema(
  type: BasePropertyTypeValue,
): z.ZodType | undefined {
  return cellValueSchemaMap[type];
}

export function validateCellValue(
  type: BasePropertyTypeValue,
  value: unknown,
): z.ZodSafeParseResult<unknown> {
  const schema = cellValueSchemaMap[type];
  if (!schema) {
    return { success: false, error: new z.ZodError([{ code: 'custom', message: `Unknown property type: ${type}`, path: [] }]) } as z.ZodSafeParseError<unknown>;
  }
  return schema.safeParse(value);
}

/*
 * Resolution context for conversions where the source type stores IDs
 * (select / multiSelect: choice uuid; person: user uuid; file: attachment
 * uuid). Callers must always supply this — the only invoker is the
 * `BASE_TYPE_CONVERSION` BullMQ worker, which builds the context per
 * chunk of rows (see `tasks/base-type-conversion.task.ts`).
 */
export type CellConversionContext = {
  fromTypeOptions?: unknown;
  userNames?: Map<string, string>;
  attachmentNames?: Map<string, string>;
  pageTitles?: Map<string, string>;
};

function resolveChoiceName(
  typeOptions: unknown,
  id: unknown,
): string | undefined {
  if (!typeOptions || typeof typeOptions !== 'object') return undefined;
  const choices = (typeOptions as any).choices;
  if (!Array.isArray(choices)) return undefined;
  const match = choices.find((c: any) => c?.id === String(id));
  return typeof match?.name === 'string' ? match.name : undefined;
}

export function attemptCellConversion(
  fromType: BasePropertyTypeValue,
  toType: BasePropertyTypeValue,
  value: unknown,
  ctx: CellConversionContext,
): { converted: boolean; value: unknown } {
  if (value === null || value === undefined) {
    return { converted: true, value: null };
  }

  // Resolve IDs to display strings before any direct parse. `select → text`
  // and `multiSelect → text` would otherwise short-circuit on z.string()
  // parsing the UUID itself and return the raw UUID instead of the name.
  if (toType === BasePropertyType.TEXT || toType === BasePropertyType.LONG_TEXT) {
    if (
      fromType === BasePropertyType.SELECT ||
      fromType === BasePropertyType.STATUS
    ) {
      const name = resolveChoiceName(ctx.fromTypeOptions, value);
      return { converted: true, value: name ?? '' };
    }
    if (fromType === BasePropertyType.MULTI_SELECT && Array.isArray(value)) {
      const parts = value
        .map((v) => resolveChoiceName(ctx.fromTypeOptions, v))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      return { converted: true, value: parts.join(', ') };
    }
    if (fromType === BasePropertyType.PERSON && ctx.userNames) {
      const ids = Array.isArray(value) ? value : [value];
      const parts = ids
        .map((v) => ctx.userNames!.get(String(v)))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      return { converted: true, value: parts.join(', ') };
    }
    if (fromType === BasePropertyType.FILE && Array.isArray(value)) {
      const parts = value
        .map((f: any) => {
          if (f && typeof f === 'object') {
            if (typeof f.fileName === 'string') return f.fileName;
            if (typeof f.id === 'string' && ctx.attachmentNames) {
              return ctx.attachmentNames.get(f.id);
            }
          }
          if (typeof f === 'string' && ctx.attachmentNames) {
            return ctx.attachmentNames.get(f);
          }
          return undefined;
        })
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      return { converted: true, value: parts.join(', ') };
    }
    if (fromType === BasePropertyType.PAGE && typeof value === 'string') {
      const title = ctx.pageTitles?.get(value);
      return { converted: true, value: title ?? '' };
    }
  }

  // Connected links become their text; a text with a URL becomes a link.
  if ((toType === BasePropertyType.TEXT || toType === BasePropertyType.LONG_TEXT || toType === BasePropertyType.URL) && fromType === BasePropertyType.CONNECTED) {
    return { converted: true, value: toType === BasePropertyType.URL ? (value as any)?.url ?? null : connectedToText(value) };
  }
  if (toType === BasePropertyType.CONNECTED && fromType !== BasePropertyType.CONNECTED) {
    return { converted: true, value: typeof value === 'string' ? parseConnectedText(value) : null };
  }

  // Places become their text, and text becomes a place when it reads as one.
  if ((toType === BasePropertyType.TEXT || toType === BasePropertyType.LONG_TEXT) && fromType === BasePropertyType.LOCATION) {
    return { converted: true, value: locationToText(value) };
  }
  if (toType === BasePropertyType.LOCATION && fromType !== BasePropertyType.LOCATION) {
    const parsed = typeof value === 'string' ? parseLocationText(value) : null;
    return { converted: true, value: parsed };
  }

  // Page cells only accept a page UUID. Free text / other IDs can't be
  // coerced into a valid page reference — drop to null.
  if (toType === BasePropertyType.PAGE && fromType !== BasePropertyType.PAGE) {
    return { converted: true, value: null };
  }

  const targetSchema = cellValueSchemaMap[toType];
  if (!targetSchema) {
    return { converted: false, value: null };
  }

  const directResult = targetSchema.safeParse(value);
  if (directResult.success) {
    return { converted: true, value: directResult.data };
  }

  if (toType === BasePropertyType.TEXT || toType === BasePropertyType.LONG_TEXT) {
    return { converted: true, value: String(value) };
  }

  if (toType === BasePropertyType.NUMBER && typeof value === 'string') {
    const num = Number(value);
    if (!isNaN(num)) {
      return { converted: true, value: num };
    }
  }

  if (toType === BasePropertyType.CHECKBOX) {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') {
        return { converted: true, value: true };
      }
      if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') {
        return { converted: true, value: false };
      }
    }
    if (typeof value === 'number') {
      return { converted: true, value: value !== 0 };
    }
  }

  if (
    toType === BasePropertyType.MULTI_SELECT &&
    fromType === BasePropertyType.SELECT &&
    typeof value === 'string'
  ) {
    return { converted: true, value: [value] };
  }

  if (
    toType === BasePropertyType.SELECT &&
    fromType === BasePropertyType.MULTI_SELECT &&
    Array.isArray(value) &&
    value.length > 0
  ) {
    return { converted: true, value: value[0] };
  }

  return { converted: false, value: null };
}

export const viewSortSchema = z.object({
  propertyId: basePropertyIdSchema,
  direction: z.enum(['asc', 'desc']),
});

/*
 * View-stored filter shape matches the engine's predicate tree (see
 * `core/base/engine/schema.zod.ts`). No legacy flat-array / operator-name
 * variants are accepted — stored view configs use `op` (eq / neq / gt /
 * lt / contains / ncontains / ...) and nested and/or groups.
 */
const viewFilterConditionSchema = z.object({
  propertyId: basePropertyIdSchema,
  op: z.enum([
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'ncontains',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty',
    'before',
    'after',
    'onOrBefore',
    'onOrAfter',
    'any',
    'none',
    'all',
  ]),
  value: z.unknown().optional(),
});

type ViewFilterCondition = z.infer<typeof viewFilterConditionSchema>;
type ViewFilterGroup = {
  op: 'and' | 'or';
  children: Array<ViewFilterCondition | ViewFilterGroup>;
};

const viewFilterNodeSchema: z.ZodType<ViewFilterCondition | ViewFilterGroup> =
  z.lazy(() => z.union([viewFilterConditionSchema, viewFilterGroupSchema]));

const viewFilterGroupSchema: z.ZodType<ViewFilterGroup> = z.lazy(() =>
  z.object({
    op: z.enum(['and', 'or']),
    children: z.array(viewFilterNodeSchema),
  }),
);

export const NO_VALUE_CHOICE_ID = '__no_value';

export const viewConfigSchema = z
  .object({
    sorts: z.array(viewSortSchema).optional(),
    filter: viewFilterGroupSchema.optional(),
    visiblePropertyIds: z.array(basePropertyIdSchema).optional(),
    hiddenPropertyIds: z.array(basePropertyIdSchema).optional(),
    propertyWidths: z.record(z.string(), z.number().positive()).optional(),
    propertyOrder: z.array(basePropertyIdSchema).optional(),
    // Kanban-only fields. `hiddenChoiceIds` and `choiceOrder` accept
    // `z.string()` (not `z.uuid()`) because the NO_VALUE_CHOICE_ID
    // sentinel ('__no_value') lives in the same array as choice uuids.
    groupByPropertyId: basePropertyIdSchema.optional(),
    // Calendar-only: the date property rows are placed by.
    calendarPropertyId: basePropertyIdSchema.optional(),
    hiddenChoiceIds: z.array(z.string()).optional(),
    choiceOrder: z.array(z.string()).optional(),
    // Gallery-only: card size and the file property shown as cover.
    cardSize: z.enum(['small', 'medium', 'large']).optional(),
    coverPropertyId: basePropertyIdSchema.optional(),
    // Feed: the long text shown as the post body, and whether the other
    // properties ride along under it.
    feedBodyPropertyId: basePropertyIdSchema.optional(),
    feedShowProperties: z.boolean().optional(),
    // Timeline: start and (optional) end date properties, zoom level.
    timelineStartPropertyId: basePropertyIdSchema.optional(),
    timelineEndPropertyId: basePropertyIdSchema.optional(),
    timelineZoom: z.enum(['day', 'week', 'month']).optional(),
    // Table/list: show sub-items nested under their parent.
    subItems: z.boolean().optional(),
    // Table: second grouping level under groupByPropertyId.
    subGroupByPropertyId: basePropertyIdSchema.optional(),
    // Chart: what is counted/summed and how it is drawn.
    chartType: z.enum(['bar', 'line', 'pie', 'donut', 'number']).optional(),
    chartXPropertyId: basePropertyIdSchema.optional(),
    chartYPropertyId: basePropertyIdSchema.optional(),
    chartAggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
    chartDateBucket: z.enum(['day', 'week', 'month', 'year']).optional(),
    chartShowValues: z.boolean().optional(),
  })
  .passthrough();

export type ViewConfig = z.infer<typeof viewConfigSchema>;
