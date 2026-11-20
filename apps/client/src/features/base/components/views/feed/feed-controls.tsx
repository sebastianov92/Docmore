import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Select, Switch } from "@mantine/core";
import { IBaseProperty } from "@/features/base/types/base.types";

const NONE = "__none";

type Props = {
  properties: IBaseProperty[];
  bodyPropertyId: string | null;
  showProperties: boolean;
  onBodyChange: (propertyId: string | null) => void;
  onShowPropertiesChange: (show: boolean) => void;
};

// Feed toolbar: which long text is the post body, and whether the other
// properties show under it.
export function FeedControls({ properties, bodyPropertyId, showProperties, onBodyChange, onShowPropertiesChange }: Props) {
  const { t } = useTranslation();
  const data = useMemo(
    () => [
      { value: NONE, label: t("No body") },
      ...properties.filter((p) => p.type === "longText" || p.type === "text").map((p) => ({ value: p.id, label: p.name || t("Untitled") })),
    ],
    [properties, t],
  );
  return (
    <>
      <Select size="xs" w={160} data={data} value={bodyPropertyId ?? NONE} onChange={(v) => onBodyChange(!v || v === NONE ? null : v)} allowDeselect={false} aria-label={t("Post body")} />
      <Switch size="xs" label={t("Properties")} checked={showProperties} onChange={(e) => onShowPropertiesChange(e.currentTarget.checked)} />
    </>
  );
}
