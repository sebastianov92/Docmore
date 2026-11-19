import { useCallback, useEffect, useRef, useState } from "react";
import { IBaseProperty } from "@/features/base/types/base.types";
import cellClasses from "@/features/base/styles/cells.module.css";

type CellPhoneProps = {
  value: unknown;
  property: IBaseProperty;
  rowId: string;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
};

// Phone numbers: free text with the usual separators; the display is a
// tel: link so the number dials on a phone.
export function CellPhone({ value, isEditing, onCommit, onCancel }: CellPhoneProps) {
  const displayValue = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(displayValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      committedRef.current = false;
      setDraft(displayValue);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, displayValue]);

  const commitOnce = useCallback(
    (val: unknown) => {
      if (committedRef.current) return;
      committedRef.current = true;
      onCommit(val);
    },
    [onCommit],
  );

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="tel"
        className={cellClasses.cellInput}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitOnce(draft.trim() || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => commitOnce(draft.trim() || null)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  if (!displayValue) {
    return <span className={cellClasses.emptyValue} />;
  }

  return (
    <a
      className={cellClasses.urlLink}
      href={`tel:${displayValue.replace(/[^+\d]/g, "")}`}
      onClick={(e) => e.stopPropagation()}
    >
      {displayValue}
    </a>
  );
}
