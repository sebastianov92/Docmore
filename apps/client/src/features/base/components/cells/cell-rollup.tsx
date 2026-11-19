import { IBaseProperty, RollupTypeOptions } from "@/features/base/types/base.types";
import cellClasses from "@/features/base/styles/cells.module.css";

type CellRollupProps = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

// Read-only: the server computes the aggregate when rows are read.
export function CellRollup({ value, property }: CellRollupProps) {
  const options = (property.typeOptions ?? {}) as RollupTypeOptions;
  if (value === null || value === undefined) return <span className={cellClasses.emptyValue} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={cellClasses.emptyValue} />;
    return <span>{value.join(", ")}</span>;
  }
  if (typeof value === "number") {
    const text = options.aggregate === "avg" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value.toLocaleString();
    return <span className={cellClasses.numberValue}>{text}</span>;
  }
  return <span>{String(value)}</span>;
}
