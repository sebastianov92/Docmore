import { z } from 'zod';
import { basePropertyIdSchema } from '../base-ids';

// What the client sends next to the JSONL file: which column goes to which
// property (existing by id, or new by name and type) and what it counted.
export const IMPORTABLE_TYPES = [
  'text',
  'longText',
  'number',
  'select',
  'status',
  'multiSelect',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'location',
] as const;

export const CSV_IMPORT_LIMITS = {
  maxRows: 100_000,
  maxColumns: 200,
  maxChoices: 500,
  maxNameLength: 255,
  batchSize: 500,
  maxFileBytes: 50 * 1024 * 1024,
} as const;

const existingColumnSchema = z.object({ propertyId: basePropertyIdSchema });
const newColumnSchema = z.object({
  name: z.string().trim().min(1).max(CSV_IMPORT_LIMITS.maxNameLength),
  type: z.enum(IMPORTABLE_TYPES),
  typeOptions: z.record(z.string(), z.unknown()).optional(),
});

export const csvImportSpecSchema = z.object({
  fileName: z.string().max(512).default('import.csv'),
  rowCount: z.number().int().min(0).max(CSV_IMPORT_LIMITS.maxRows),
  columns: z
    .array(z.union([existingColumnSchema, newColumnSchema]))
    .min(1)
    .max(CSV_IMPORT_LIMITS.maxColumns),
  skippedValues: z.number().int().min(0).optional().default(0),
});

export type CsvImportSpec = z.infer<typeof csvImportSpecSchema>;
export type CsvImportColumn = CsvImportSpec['columns'][number];
