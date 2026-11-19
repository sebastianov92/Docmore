export type BasePropertyType =
  | 'text'
  | 'longText'
  | 'number'
  | 'select'
  | 'status'
  | 'multiSelect'
  | 'date'
  | 'person'
  | 'file'
  | 'page'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'id'
  | 'relation'
  | 'rollup'
  | 'createdAt'
  | 'lastEditedAt'
  | 'lastEditedBy'
  | 'formula';

export type Choice = {
  id: string;
  name: string;
  color: string;
  category?: 'todo' | 'inProgress' | 'complete';
};

export type SelectTypeOptions = {
  choices: Choice[];
  choiceOrder: string[];
  disableColors?: boolean;
  defaultValue?: string | string[] | null;
};

export type NumberTypeOptions = {
  format?: 'plain' | 'currency' | 'percent' | 'progress';
  precision?: number;
  currencySymbol?: string;
  defaultValue?: number | null;
};

export type DateTypeOptions = {
  dateFormat?: string;
  timeFormat?: '12h' | '24h';
  includeTime?: boolean;
  defaultValue?: string | null;
};

export type TextTypeOptions = {
  richText?: boolean;
  defaultValue?: string | null;
};

export type CheckboxTypeOptions = {
  defaultValue?: boolean;
};

export type UrlTypeOptions = {
  defaultValue?: string | null;
};

export type EmailTypeOptions = {
  defaultValue?: string | null;
};

export type PersonTypeOptions = {
  allowMultiple?: boolean;
};

export type PageTypeOptions = Record<string, never>;

// ID: per-base row number shown with an optional prefix ("INV-12").
export type IdTypeOptions = {
  prefix?: string;
};

// Relation: rows of another base (cell = array of row ids).
export type RelationTypeOptions = {
  targetPageId: string;
  allowMultiple?: boolean;
};

export type RollupAggregate = "count" | "sum" | "avg" | "min" | "max" | "show";
// Rollup: aggregate over the rows a relation points to; computed on read.
export type RollupTypeOptions = {
  relationPropertyId: string;
  targetPropertyId?: string;
  aggregate: RollupAggregate;
};

export type TypeOptions =
  | SelectTypeOptions
  | NumberTypeOptions
  | DateTypeOptions
  | TextTypeOptions
  | CheckboxTypeOptions
  | UrlTypeOptions
  | EmailTypeOptions
  | PersonTypeOptions
  | PageTypeOptions
  | IdTypeOptions
  | RelationTypeOptions
  | RollupTypeOptions
  | Record<string, unknown>;

export type IBaseProperty = {
  id: string;
  pageId: string;
  name: string;
  // who may see the column; 'all' when unset
  restrictedTo?: PropertyRestriction;
  type: BasePropertyType;
  position: string;
  typeOptions: TypeOptions;
  // Set while a background type-conversion job is rewriting cells. The
  // live `type` stays on the old kind until the job commits, so cells
  // render correctly; the column header shows a "Converting…" badge.
  pendingType?: BasePropertyType | null;
  pendingTypeOptions?: TypeOptions | null;
  isPrimary: boolean;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
};

export type IBaseRow = {
  id: string;
  pageId: string;
  cells: Record<string, unknown>;
  position: string;
  creatorId: string;
  lastUpdatedById: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  // Per-base number behind the ID property; null on template rows.
  rowNo?: number | null;
  isTemplate?: boolean;
  // Sub-item of another row of this base; rows that must finish first.
  parentRowId?: string | null;
  blockedBy?: string[];
  // client-side: nesting depth under its parent (sub-items on)
  depth?: number;
};

export type ViewSortConfig = {
  propertyId: string;
  direction: 'asc' | 'desc';
};

// Matches the server's engine operator set (core/base/engine/schema.zod.ts).
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'ncontains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'before'
  | 'after'
  | 'onOrBefore'
  | 'onOrAfter'
  | 'any'
  | 'none'
  | 'all';

export type FilterCondition = {
  propertyId: string;
  op: FilterOperator;
  value?: unknown;
};

export type FilterGroup = {
  op: 'and' | 'or';
  children: Array<FilterCondition | FilterGroup>;
};

export type FilterNode = FilterCondition | FilterGroup;

export type SearchSpec = {
  query: string;
  mode?: 'trgm' | 'fts';
};

export const NO_VALUE_CHOICE_ID = '__no_value';

export type ViewConfig = {
  sorts?: ViewSortConfig[];
  filter?: FilterGroup;
  visiblePropertyIds?: string[];
  hiddenPropertyIds?: string[];
  propertyWidths?: Record<string, number>;
  propertyOrder?: string[];
  // Kanban
  groupByPropertyId?: string;
  // Calendar
  calendarPropertyId?: string;
  hiddenChoiceIds?: string[];
  choiceOrder?: string[];
  // Gallery
  cardSize?: 'small' | 'medium' | 'large';
  coverPropertyId?: string;
  // Timeline
  timelineStartPropertyId?: string;
  timelineEndPropertyId?: string;
  timelineZoom?: 'day' | 'week' | 'month';
  // Table/list: nest sub-items under their parent
  subItems?: boolean;
  // Table: second grouping level
  subGroupByPropertyId?: string;
  // Chart
  chartType?: 'bar' | 'line' | 'pie' | 'donut' | 'number';
  chartXPropertyId?: string;
  chartYPropertyId?: string;
  chartAggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  chartDateBucket?: 'day' | 'week' | 'month' | 'year';
  chartShowValues?: boolean;
};

export type BaseViewType = 'table' | 'kanban' | 'calendar' | 'list' | 'gallery' | 'timeline' | 'chart';

export type ReferenceUser = { id: string; name: string | null; avatarUrl: string | null };
export type ReferencePage = {
  id: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceId: string;
  space: { id: string; slug: string; name: string } | null;
};
export type ReferenceRow = { id: string; pageId: string; title: string };
export type RowReferences = {
  users: Record<string, ReferenceUser>;
  pages: Record<string, ReferencePage>;
  rows?: Record<string, ReferenceRow>;
};

export type IBaseView = {
  id: string;
  pageId: string;
  name: string;
  type: BaseViewType;
  config: ViewConfig;
  workspaceId: string;
  creatorId: string;
  createdAt: string;
  updatedAt: string;
};

export type IBase = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  pageId?: string;
  spaceId: string;
  workspaceId: string;
  creatorId: string;
  properties: IBaseProperty[];
  views: IBaseView[];
  createdAt: string;
  updatedAt: string;
  slugId?: string;
  isBase?: boolean;
  baseSchemaVersion?: number;
  // Structure lock: properties and views stay as they are.
  baseLocked?: boolean;
  permissions?: {
    canEdit: boolean;
    hasRestriction: boolean;
    // space admins (and workspace owners/admins) may restrict columns
    canManage?: boolean;
    visibility?: PropertyRestriction;
  };
};

export type EditingCell = {
  rowId: string;
  propertyId: string;
} | null;

export type BaseTemplate = "kanban";

export type CreateBaseInput = {
  name?: string;
  description?: string;
  icon?: string;
  pageId?: string;
  // Standalone base in a space, or inline child of a page.
  spaceId?: string;
  parentPageId?: string;
  template?: BaseTemplate;
};

export type UpdateBaseInput = {
  pageId: string;
  name?: string;
  description?: string;
  icon?: string;
  locked?: boolean;
};

export type CreatePropertyInput = {
  pageId: string;
  name: string;
  type: BasePropertyType;
  typeOptions?: TypeOptions;
  requestId?: string;
};

export type UpdatePropertyInput = {
  restrictedTo?: 'all' | 'editors' | 'admins';
  propertyId: string;
  pageId: string;
  name?: string;
  type?: BasePropertyType;
  typeOptions?: TypeOptions;
  requestId?: string;
};

export type DeletePropertyInput = {
  propertyId: string;
  pageId: string;
  requestId?: string;
};

export type ReorderPropertyInput = {
  propertyId: string;
  pageId: string;
  position: string;
  requestId?: string;
};

export type CountRowsInput = {
  pageId: string;
  filter?: FilterNode;
  search?: SearchSpec;
  // When true the server returns an exact (but capped) count. Otherwise
  // a cheap EXPLAIN-plan estimate. Paired with `capped` on the result.
  exact?: boolean;
};

export type CountRowsResult = {
  value: number;
  exact: boolean;
  capped: boolean;
};

export type CreateRowInput = {
  pageId: string;
  cells?: Record<string, unknown>;
  afterRowId?: string;
  requestId?: string;
  // Template rows live apart from the data and seed new rows.
  isTemplate?: boolean;
  fromTemplateId?: string;
  parentRowId?: string;
  blockedBy?: string[];
};

export type UpdateRowInput = {
  rowId: string;
  pageId: string;
  cells: Record<string, unknown>;
  position?: string;
  requestId?: string;
  parentRowId?: string | null;
  blockedBy?: string[] | null;
};

export type DeleteRowInput = {
  rowId: string;
  pageId: string;
  requestId?: string;
};

export type DeleteRowsInput = {
  pageId: string;
  rowIds: string[];
  requestId?: string;
};

export type ReorderRowInput = {
  rowId: string;
  pageId: string;
  position: string;
  requestId?: string;
};

export type CreateViewInput = {
  pageId: string;
  name: string;
  type?: BaseViewType;
  config?: ViewConfig;
};

export type UpdateViewInput = {
  viewId: string;
  pageId: string;
  name?: string;
  type?: BaseViewType;
  config?: ViewConfig;
};

export type DeleteViewInput = {
  viewId: string;
  pageId: string;
};

export type UpdatePropertyResult = {
  property: IBaseProperty;
  // Non-null when the property change kicked off a BullMQ type-conversion
  // job (select/multiSelect/person/file → anything, or any → system type).
  // Client can listen for `base:schema:bumped` on the base room to know
  // when the job finished migrating cells.
  jobId: string | null;
};

// Local-first draft of filter / sort tweaks for a single view, stored in
// localStorage scoped to (userId, baseId, viewId). An absent `filter` or
// `sorts` field means "inherit the baseline for that axis". See
// `.claude/superpowers/specs/2026-04-20-base-view-draft-design.md`.
export type BaseViewDraft = {
  filter?: FilterGroup;
  sorts?: ViewSortConfig[];
  // ISO timestamp written on each put; diagnostic only, not read by logic.
  updatedAt: string;
};

export type {
  FormulaTypeOptions,
  FormulaResultType,
  ErrorCell as FormulaErrorCell,
  ErrorCode as FormulaErrorCode,
} from "@docmore/base-formula/client";
export { isErrorCell as isFormulaErrorCell } from "@docmore/base-formula/client";

export type PropertyRestriction = 'all' | 'editors' | 'admins';

// One cell snapshot of a row, taken before an edit, delete or conversion.
export type IRowVersion = {
  id: string;
  rowId: string;
  kind: 'update' | 'delete' | 'convert' | 'restore' | string;
  cells: Record<string, unknown>;
  title: string;
  actorId: string | null;
  actorName: string | null;
  actorAvatarUrl: string | null;
  createdAt: string;
  rowDeleted: boolean;
};

export type IRowVersionPage = {
  items: IRowVersion[];
  meta: { hasNextPage: boolean; nextBefore: string | null };
};
