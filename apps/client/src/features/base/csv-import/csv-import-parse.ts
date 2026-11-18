import Papa from "papaparse";
import { IBaseProperty } from "@/features/base/types/base.types";
import {
  ColumnMapping,
  ColumnTarget,
  CSV_IMPORT_LIMITS,
  IMPORTABLE_TYPES,
  ImportableType,
  ImportSpec,
  ParsedCsv,
} from "./csv-import.types";

// Parses the file in the browser; only the mapped values travel to the
// server, one JSON array per row.
export function parseCsvFile(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => {
        const data = result.data.filter((row) => Array.isArray(row));
        if (data.length === 0) {
          reject(new Error("The file is empty"));
          return;
        }
        const headers = data[0].map((h, i) => (h ?? "").toString().trim() || `Column ${i + 1}`);
        if (headers.length > CSV_IMPORT_LIMITS.maxColumns) {
          reject(new Error(`A CSV can have at most ${CSV_IMPORT_LIMITS.maxColumns} columns`));
          return;
        }
        const body = data.slice(1).map((row) =>
          headers.map((_, i) => (row[i] ?? "").toString()),
        );
        const rows = body.slice(0, CSV_IMPORT_LIMITS.maxRows);
        resolve({ headers, rows, truncatedRows: body.length - rows.length });
      },
      error: (err) => reject(err),
    });
  });
}

const BOOL_WORDS = new Set(["true", "false", "yes", "no", "y", "n", "1", "0", "on", "off", "x", ""]);

// Guesses a property type from the column's values.
export function detectType(values: string[]): ImportableType {
  const filled = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (filled.length === 0) return "text";
  const every = (test: (v: string) => boolean) => filled.every(test);
  if (every((v) => BOOL_WORDS.has(v.toLowerCase()))) return "checkbox";
  if (every((v) => /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (every((v) => /^\S+@\S+\.\S+$/.test(v))) return "email";
  if (every((v) => /^https?:\/\/\S+$/i.test(v))) return "url";
  if (every((v) => /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v) && !Number.isNaN(new Date(v).getTime()))) {
    return "date";
  }
  if (filled.some((v) => v.length > 300 || v.includes("\n"))) return "longText";
  const distinct = new Set(filled.map((v) => v.toLowerCase()));
  if (filled.length >= 3 && distinct.size <= 20 && distinct.size <= Math.ceil(filled.length / 2)) {
    return "select";
  }
  return "text";
}

// First mapping: match headers to existing properties by name, otherwise a
// new property with a guessed type.
export function initialMappings(parsed: ParsedCsv, properties: IBaseProperty[]): ColumnMapping[] {
  const byName = new Map(properties.map((p) => [p.name.trim().toLowerCase(), p]));
  const used = new Set<string>();
  return parsed.headers.map((header, index) => {
    const values = parsed.rows.map((r) => r[index] ?? "");
    const existing = byName.get(header.toLowerCase());
    let target: ColumnTarget;
    if (existing && !used.has(existing.id) && isImportable(existing.type)) {
      used.add(existing.id);
      target = { kind: "existing", propertyId: existing.id };
    } else {
      target = { kind: "new", name: header, type: detectType(values) };
    }
    return { index, header, samples: values.slice(0, 3), target };
  });
}

export function isImportable(type: string): type is ImportableType {
  return (IMPORTABLE_TYPES as readonly string[]).includes(type);
}

// Splits multi-value cells ("a, b") for multi-select and person columns.
function splitList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// A date without a time means that calendar day for the person importing,
// so it is sent as local midnight; the server cannot know their time zone.
function localDateToIso(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function buildImport(
  parsed: ParsedCsv,
  mappings: ColumnMapping[],
  properties: IBaseProperty[],
  fileName: string,
): { spec: ImportSpec; jsonl: Blob; rowCount: number } {
  const active = mappings.filter((m) => m.target.kind !== "skip");
  const typeOf = (m: ColumnMapping): string => {
    if (m.target.kind === "existing") {
      const wanted = m.target.propertyId;
      return properties.find((p) => p.id === wanted)?.type ?? "text";
    }
    return m.target.kind === "new" ? m.target.type : "text";
  };
  const columns = active.map((m) =>
    m.target.kind === "existing"
      ? { propertyId: m.target.propertyId }
      : { name: (m.target as { name: string }).name, type: (m.target as { type: ImportableType }).type },
  );
  const lines: string[] = [];
  for (const row of parsed.rows) {
    const values = active.map((m) => {
      const raw = (row[m.index] ?? "").trim();
      if (!raw) return null;
      const type = typeOf(m);
      if (type === "multiSelect" || type === "person") return splitList(raw);
      if (type === "date") return localDateToIso(raw);
      return raw;
    });
    if (values.every((v) => v === null)) continue;
    lines.push(JSON.stringify(values));
  }
  const spec: ImportSpec = {
    fileName,
    rowCount: lines.length,
    columns,
    skippedValues: 0,
  };
  return { spec, jsonl: new Blob([lines.join("\n")], { type: "application/x-ndjson" }), rowCount: lines.length };
}
