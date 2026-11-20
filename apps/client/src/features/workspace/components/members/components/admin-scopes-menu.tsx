import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Popover, Stack, Text } from "@mantine/core";
import { IconAdjustments } from "@tabler/icons-react";
import { adminScopeData } from "@/features/workspace/types/user-role-data.ts";

type Props = {
  scopes: string[] | null | undefined;
  onChange: (scopes: string[] | null) => void;
};

// Which parts of the workspace this admin manages; everything unless narrowed.
export function AdminScopesMenu({ scopes, onChange }: Props) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const all = scopes === null || scopes === undefined;
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" withinPortal shadow="md" width={240}>
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconAdjustments size={12} />} onClick={() => setOpened((o) => !o)} data-testid="admin-scopes">
          {all ? t("Everything") : t("{{count}} areas", { count: scopes!.length })}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            {t("This admin manages")}
          </Text>
          <Checkbox size="xs" label={t("Everything")} checked={all} onChange={(e) => onChange(e.currentTarget.checked ? null : [])} />
          {adminScopeData.map((s) => (
            <Checkbox
              key={s.value}
              size="xs"
              label={t(s.label)}
              checked={all || scopes!.includes(s.value)}
              disabled={all}
              onChange={(e) => {
                const current = scopes ?? [];
                onChange(e.currentTarget.checked ? [...current, s.value] : current.filter((x) => x !== s.value));
              }}
            />
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
