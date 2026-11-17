import { useEffect, useState } from "react";
import { Button, Group, NumberInput, Select, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

// The server keeps a plain day count; the form offers coarser units and
// picks the largest one that divides the stored value evenly.
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

type Unit = "days" | "weeks" | "months" | "years";
const DAYS_PER_UNIT: Record<Unit, number> = {
  days: 1,
  weeks: 7,
  months: 30,
  years: 365,
};

export function splitRetention(days: number): { amount: number; unit: Unit } {
  for (const unit of ["years", "months", "weeks"] as Unit[]) {
    const size = DAYS_PER_UNIT[unit];
    if (days >= size && days % size === 0) {
      return { amount: days / size, unit };
    }
  }
  return { amount: days, unit: "days" };
}

export function joinRetention(amount: number, unit: Unit): number {
  return Math.max(1, Math.round(amount)) * DAYS_PER_UNIT[unit];
}

export default function TrashRetentionSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const storedDays =
    workspace?.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;

  const [amount, setAmount] = useState<number | string>(
    splitRetention(storedDays).amount,
  );
  const [unit, setUnit] = useState<Unit>(splitRetention(storedDays).unit);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const parsed = splitRetention(storedDays);
    setAmount(parsed.amount);
    setUnit(parsed.unit);
  }, [storedDays]);

  const numericAmount = typeof amount === "number" ? amount : NaN;
  const nextDays = Number.isFinite(numericAmount)
    ? joinRetention(numericAmount, unit)
    : null;
  const dirty = nextDays !== null && nextDays !== storedDays;

  const save = async () => {
    if (nextDays === null || !dirty) return;
    setSaving(true);
    try {
      const updated = await updateWorkspace({ trashRetentionDays: nextDays });
      setWorkspace(updated);
      notifications.show({ message: t("Trash retention updated") });
    } catch (err) {
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to update trash retention")),
        color: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  const unitOptions = [
    { value: "days", label: t("days") },
    { value: "weeks", label: t("weeks") },
    { value: "months", label: t("months") },
    { value: "years", label: t("years") },
  ];

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Trash retention")}</Text>
        <Text size="sm" c="dimmed">
          {t("Pages left in the trash this long are deleted for good.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Group gap="xs" wrap="nowrap">
          <NumberInput
            value={amount}
            onChange={(value) => setAmount(typeof value === "bigint" ? Number(value) : value)}
            min={1}
            max={9999}
            allowDecimal={false}
            hideControls
            size="sm"
            w={72}
            aria-label={t("Retention amount")}
          />
          <Select
            data={unitOptions}
            value={unit}
            onChange={(value) => value && setUnit(value as Unit)}
            allowDeselect={false}
            size="sm"
            w={120}
            comboboxProps={{ withinPortal: true }}
            aria-label={t("Retention unit")}
          />
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
            {t("Save")}
          </Button>
        </Group>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
