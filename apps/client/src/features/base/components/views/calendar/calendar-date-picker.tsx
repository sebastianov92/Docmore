import { Button, Menu, Text } from "@mantine/core";
import { IconCalendar, IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IBaseProperty } from "@/features/base/types/base.types";
import { isDateLike } from "./calendar-utils";

type Props = {
  properties: IBaseProperty[];
  value: string | null;
  onChange: (propertyId: string) => void;
  size?: "xs" | "sm" | "md";
};

// Toolbar control: which date property the calendar places rows by.
export function CalendarDatePicker({ properties, value, onChange, size = "sm" }: Props) {
  const { t } = useTranslation();
  const candidates = properties.filter(isDateLike);
  const current = candidates.find((p) => p.id === value) ?? candidates[0];
  return (
    <Menu position="bottom-start" withinPortal shadow="md" width={220}>
      <Menu.Target>
        <Button
          variant="default"
          size={size}
          leftSection={<IconCalendar size={14} />}
          rightSection={<IconChevronDown size={12} />}
        >
          {current ? current.name : t("Date property")}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {candidates.length === 0 && (
          <Menu.Label>
            <Text size="xs">{t("No date properties yet")}</Text>
          </Menu.Label>
        )}
        {candidates.map((p) => (
          <Menu.Item key={p.id} onClick={() => onChange(p.id)} fw={p.id === current?.id ? 600 : undefined}>
            {p.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
