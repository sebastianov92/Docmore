import { IBaseProperty, IdTypeOptions } from "@/features/base/types/base.types";
import cellClasses from "@/features/base/styles/cells.module.css";

type CellIdProps = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

// Read-only: the per-base row number with the property's prefix.
export function formatRowId(property: IBaseProperty, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const prefix = (property.typeOptions as IdTypeOptions | undefined)?.prefix ?? "";
  return `${prefix}${value}`;
}

export function CellId({ value, property }: CellIdProps) {
  const text = formatRowId(property, value);
  if (!text) return <span className={cellClasses.emptyValue} />;
  return <span>{text}</span>;
}
