import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl, Select } from "@mantine/core";
import { IBaseProperty } from "@/features/base/types/base.types";

const NONE = "__none";

type Props = {
  properties: IBaseProperty[];
  coverPropertyId: string | null;
  cardSize: "small" | "medium" | "large";
  onCoverChange: (propertyId: string | null) => void;
  onSizeChange: (size: "small" | "medium" | "large") => void;
};

// Gallery toolbar: which file property is the cover, and the card size.
export function GalleryControls({
  properties,
  coverPropertyId,
  cardSize,
  onCoverChange,
  onSizeChange,
}: Props) {
  const { t } = useTranslation();
  const data = useMemo(
    () => [
      { value: NONE, label: t("No cover") },
      ...properties
        .filter((p) => p.type === "file")
        .map((p) => ({ value: p.id, label: p.name || t("Untitled") })),
    ],
    [properties, t],
  );
  return (
    <>
      <Select
        size="xs"
        w={150}
        data={data}
        value={coverPropertyId ?? NONE}
        onChange={(v) => onCoverChange(!v || v === NONE ? null : v)}
        allowDeselect={false}
        aria-label={t("Cover")}
      />
      <SegmentedControl
        size="xs"
        value={cardSize}
        onChange={(v) => onSizeChange(v as "small" | "medium" | "large")}
        data={[
          { value: "small", label: "S" },
          { value: "medium", label: "M" },
          { value: "large", label: "L" },
        ]}
        aria-label={t("Card size")}
      />
    </>
  );
}
