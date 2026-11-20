import { BasePropertyType } from "@/features/base/types/base.types";

// Property types a CSV column can be imported into.
export const IMPORTABLE_TYPES = [
  "text",
  "longText",
  "number",
  "select",
  "status",
  "multiSelect",
  "date",
  "person",
  "checkbox",
  "url",
  "email",
  "phone",
  "location",
  "connected",
] as const satisfies readonly BasePropertyType[];

export type ImportableType = (typeof IMPORTABLE_TYPES)[number];

export const CSV_IMPORT_LIMITS = {
  maxRows: 100_000,
  maxColumns: 200,
  maxFileBytes: 50 * 1024 * 1024,
} as const;

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  // Rows dropped because the file had more than the limit.
  truncatedRows: number;
};

export type ColumnTarget =
  | { kind: "skip" }
  | { kind: "existing"; propertyId: string }
  | { kind: "new"; name: string; type: ImportableType };

export type ColumnMapping = {
  index: number;
  header: string;
  samples: string[];
  target: ColumnTarget;
};

// What goes to the server next to the JSONL file.
export type ImportSpecColumn =
  | { propertyId: string }
  | { name: string; type: ImportableType; typeOptions?: Record<string, unknown> };

export type ImportSpec = {
  fileName: string;
  rowCount: number;
  columns: ImportSpecColumn[];
  skippedValues: number;
};

export type ImportProgress = {
  fileTaskId: string;
  status: "running" | "success" | "failed";
  processedRows: number;
  totalRows: number;
  importedRows?: number;
  skippedValues?: number;
  error?: string | null;
};
