import { useEffect, useState } from "react";
import { Button, Group, NumberInput, Select, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  useAuditRetentionQuery,
  useUpdateAuditRetentionMutation,
} from "@/features/audit/queries/audit-query";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

type Unit = "days" | "weeks" | "months" | "years";
const DAYS: Record<Unit, number> = { days: 1, weeks: 7, months: 30, years: 365 };
const DEFAULT_DAYS = 365;

function split(days: number): { amount: number; unit: Unit } {
  for (const unit of ["years", "months", "weeks"] as Unit[]) {
    if (days >= DAYS[unit] && days % DAYS[unit] === 0) {
      return { amount: days / DAYS[unit], unit };
    }
  }
  return { amount: days, unit: "days" };
}

// How long audit rows are kept; the server sweeps older ones daily.
export default function AuditRetentionSetting() {
  const { t } = useTranslation();
  const { data } = useAuditRetentionQuery();
  const update = useUpdateAuditRetentionMutation();
  const storedDays = data?.retentionDays ?? DEFAULT_DAYS;

  const [amount, setAmount] = useState<number | string>(split(storedDays).amount);
  const [unit, setUnit] = useState<Unit>(split(storedDays).unit);

  useEffect(() => {
    const parsed = split(storedDays);
    setAmount(parsed.amount);
    setUnit(parsed.unit);
  }, [storedDays]);

  const numeric = typeof amount === "number" ? amount : NaN;
  const nextDays = Number.isFinite(numeric)
    ? Math.max(1, Math.round(numeric)) * DAYS[unit]
    : null;
  const dirty = nextDays !== null && nextDays !== storedDays;

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Keep audit logs for")}</Text>
        <Text size="sm" c="dimmed">
          {t("Older events are deleted for good, once a day.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Group gap="xs" wrap="nowrap">
          <NumberInput
            value={amount}
            onChange={(value) => setAmount(typeof value === "bigint" ? Number(value) : value)}
            min={1}
            max={3650}
            allowDecimal={false}
            hideControls
            size="sm"
            w={72}
            aria-label={t("Retention amount")}
          />
          <Select
            data={[
              { value: "days", label: t("days") },
              { value: "weeks", label: t("weeks") },
              { value: "months", label: t("months") },
              { value: "years", label: t("years") },
            ]}
            value={unit}
            onChange={(value) => value && setUnit(value as Unit)}
            allowDeselect={false}
            size="sm"
            w={120}
            comboboxProps={{ withinPortal: true }}
            aria-label={t("Retention unit")}
          />
          <Button
            size="sm"
            onClick={() => nextDays && update.mutate({ auditRetentionDays: nextDays })}
            loading={update.isPending}
            disabled={!dirty}
          >
            {t("Save")}
          </Button>
        </Group>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
