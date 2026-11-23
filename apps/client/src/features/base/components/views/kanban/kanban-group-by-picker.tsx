import { useMemo } from "react";
import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { IBaseProperty } from "@/features/base/types/base.types";

type KanbanGroupByPickerProps = {
  properties: IBaseProperty[];
  value: string | null;
  onChange: (propertyId: string) => void;
  // Allows the toolbar variant to render compact / narrow.
  size?: "xs" | "sm" | "md";
  // List views may drop the grouping again.
  onClear?: () => void;
  placeholder?: string;
  // The kinds of property on offer. Tables and lists group by one option
  // per row; a board also takes a multi-select.
  types?: readonly string[];
};

const ONE_OPTION: readonly string[] = ["select", "status"];

export function KanbanGroupByPicker({
  properties,
  value,
  onChange,
  size = "sm",
  onClear,
  placeholder,
  types = ONE_OPTION,
}: KanbanGroupByPickerProps) {
  const { t } = useTranslation();
  const data = useMemo(
    () =>
      properties
        .filter((p) => types.includes(p.type))
        .map((p) => ({ value: p.id, label: p.name || t("Untitled") })),
    [properties, t, types],
  );
  return (
    <Select
      placeholder={placeholder ?? t("Group by…")}
      data={data}
      value={value}
      onChange={(v) => (v ? onChange(v) : onClear?.())}
      size={size}
      allowDeselect={Boolean(onClear)}
      clearable={Boolean(onClear)}
      searchable
    />
  );
}
