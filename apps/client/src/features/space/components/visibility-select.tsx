import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { SpaceVisibility } from "@/features/space/types/space.types";

interface Props {
  value: SpaceVisibility;
  onChange: (value: SpaceVisibility) => void;
  readOnly?: boolean;
  error?: React.ReactNode;
}

// Who sees the space in the directory and how they get in.
export function SpaceVisibilitySelect({ value, onChange, readOnly, error }: Props) {
  const { t } = useTranslation();
  const data = [
    { value: "open", label: t("Open: any member can find it and join") },
    { value: "closed", label: t("Closed: listed, joining needs approval") },
    { value: "private", label: t("Private: only members see it") },
  ];
  return (
    <Select
      id="visibility"
      label={t("Visibility")}
      variant="filled"
      data={data}
      value={value}
      onChange={(v) => v && onChange(v as SpaceVisibility)}
      allowDeselect={false}
      readOnly={readOnly}
      error={error}
      checkIconPosition="right"
      aria-label={t("Visibility")}
    />
  );
}
