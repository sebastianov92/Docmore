import { Select, SelectProps } from "@mantine/core";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role";
import { ISpace } from "@/features/space/types/space.types";

export const GLOBAL_SCOPE = "";

interface TemplateScopeSelectProps extends Omit<SelectProps, "data" | "value" | "onChange"> {
  spaces: ISpace[];
  value: string | null;
  onChange: (spaceId: string | null) => void;
}

// Global is only offered to workspace admins; members pick one of their spaces.
export function TemplateScopeSelect({ spaces, value, onChange, ...props }: TemplateScopeSelectProps) {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  const data = [
    ...(isAdmin
      ? [{ group: t("Workspace"), items: [{ value: GLOBAL_SCOPE, label: t("Everyone in the workspace") }] }]
      : []),
    ...(spaces.length
      ? [{ group: t("Spaces"), items: spaces.map((space) => ({ value: space.id, label: space.name })) }]
      : []),
  ];

  return (
    <Select
      label={t("Available in")}
      data={data}
      value={value ?? GLOBAL_SCOPE}
      onChange={(next) => onChange(next ? next : null)}
      searchable
      allowDeselect={false}
      comboboxProps={{ withinPortal: true }}
      {...props}
    />
  );
}
