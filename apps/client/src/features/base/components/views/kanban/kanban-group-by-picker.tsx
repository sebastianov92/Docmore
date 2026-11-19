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
};

export function KanbanGroupByPicker({
  properties,
  value,
  onChange,
  size = "sm",
  onClear,
}: KanbanGroupByPickerProps) {
  const { t } = useTranslation();
  const data = useMemo(
    () =>
      properties
        .filter((p) => p.type === "select" || p.type === "status")
        .map((p) => ({ value: p.id, label: p.name || t("Untitled") })),
    [properties, t],
  );
  return (
    <Select
      placeholder={t("Group by…")}
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
