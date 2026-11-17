import { Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconCheck, IconChevronDown, IconLock, IconUsers } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import classes from "./page-access.module.css";

export type AccessLevel = "open" | "restricted";

interface AccessLevelPickerProps {
  value: AccessLevel;
  inherited: boolean;
  disabled?: boolean;
  onChange: (value: AccessLevel) => void;
}

// One tappable row that says who can reach the page, with a menu to change it.
export function AccessLevelPicker({ value, inherited, disabled, onChange }: AccessLevelPickerProps) {
  const { t } = useTranslation();
  const restricted = value === "restricted";

  const title = restricted
    ? t("Restricted")
    : inherited
      ? t("Restricted by a parent page")
      : t("Everyone in the space");
  const detail = restricted
    ? t("Only the people listed below can open this page.")
    : inherited
      ? t("Whoever can open the parent page can open this one.")
      : t("Anyone with access to the space can open this page.");

  const options: { value: AccessLevel; label: string; detail: string; icon: typeof IconLock }[] = [
    {
      value: "open",
      label: inherited ? t("Same as the parent page") : t("Everyone in the space"),
      detail: inherited ? t("No extra restriction on this page.") : t("Follows the space permissions."),
      icon: IconUsers,
    },
    {
      value: "restricted",
      label: t("Restricted"),
      detail: t("Pick exactly who can view or edit."),
      icon: IconLock,
    },
  ];

  return (
    <Menu position="bottom-start" width={320} disabled={disabled} withinPortal>
      <Menu.Target>
        <UnstyledButton className={classes.accessRow} disabled={disabled}>
          <span
            className={`${classes.accessIcon} ${restricted || inherited ? classes.accessIconRestricted : ""}`}
          >
            {restricted || inherited ? <IconLock size={18} stroke={1.5} /> : <IconUsers size={18} stroke={1.5} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Group gap={4} wrap="nowrap">
              <Text size="sm" fw={500}>
                {title}
              </Text>
              {!disabled && <IconChevronDown size={14} />}
            </Group>
            <Text size="xs" c="dimmed">
              {detail}
            </Text>
          </div>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onChange(option.value)}
            leftSection={<option.icon size={16} stroke={1.5} />}
            rightSection={option.value === value ? <IconCheck size={16} /> : null}
          >
            <Text size="sm">{option.label}</Text>
            <Text size="xs" c="dimmed">
              {option.detail}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
