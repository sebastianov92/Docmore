import { lazy, Suspense } from "react";
import { Group, NumberInput, SegmentedControl, Select, Skeleton, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { PERIOD_AMOUNT_MIN, PERIOD_UNIT_MAX_AMOUNT } from "@/features/page-verification/constants";
import { ExpirationMode, PeriodUnit } from "@/features/page-verification/types";
import { addDays, isValidPeriod, periodEndsAt, pluralUnit } from "@/features/page-verification/utils";

const DateInput = lazy(() =>
  import("@mantine/dates").then((m) => ({ default: m.DateInput })),
);

export interface ExpirationValue {
  mode: ExpirationMode;
  periodAmount: number;
  periodUnit: PeriodUnit;
  fixedDate: Date | null;
}

interface Props {
  value: ExpirationValue;
  onChange: (next: ExpirationValue) => void;
  // The date the next period counts from: now for a new verification, the
  // last verification for an existing one.
  from?: Date;
}

export function isExpirationValid(value: ExpirationValue): boolean {
  if (value.mode === "period") return isValidPeriod(value.periodAmount, value.periodUnit);
  if (value.mode === "fixed") return !!value.fixedDate && value.fixedDate.getTime() > Date.now();
  return true;
}

export default function ExpirationFields({ value, onChange, from }: Props) {
  const { t } = useTranslation();
  const set = (patch: Partial<ExpirationValue>) => onChange({ ...value, ...patch });
  const max = PERIOD_UNIT_MAX_AMOUNT[value.periodUnit];

  let hint: string | null = null;
  if (value.mode === "period") {
    hint = isValidPeriod(value.periodAmount, value.periodUnit)
      ? t("Due again {{date}}", {
          date: periodEndsAt(value.periodAmount, value.periodUnit, from).toLocaleDateString(),
        })
      : t("Between {{min}} and {{max}} {{unit}}", {
          min: PERIOD_AMOUNT_MIN,
          max,
          unit: pluralUnit(value.periodUnit, max, t),
        });
  } else if (value.mode === "fixed") {
    hint = value.fixedDate
      ? t("Expires {{date}}", { date: value.fixedDate.toLocaleDateString() })
      : t("Pick the date the verification runs out.");
  } else {
    hint = t("Never expires. Verifiers can still re-verify at any time.");
  }

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        value={value.mode}
        onChange={(mode) => set({ mode: mode as ExpirationMode })}
        data={[
          { value: "period", label: t("Every") },
          { value: "fixed", label: t("Until a date") },
          { value: "indefinite", label: t("Indefinitely") },
        ]}
      />
      {value.mode === "period" && (
        <Group gap="xs" wrap="nowrap">
          <NumberInput
            value={value.periodAmount}
            onChange={(v) => set({ periodAmount: typeof v === "number" ? v : Number(v) || 0 })}
            min={PERIOD_AMOUNT_MIN}
            max={max}
            allowDecimal={false}
            hideControls
            size="sm"
            w={80}
            aria-label={t("Period amount")}
          />
          <Select
            data={[
              { value: "day", label: t("days") },
              { value: "week", label: t("weeks") },
              { value: "month", label: t("months") },
              { value: "year", label: t("years") },
            ]}
            value={value.periodUnit}
            onChange={(unit) => unit && set({ periodUnit: unit as PeriodUnit })}
            allowDeselect={false}
            size="sm"
            w={130}
            comboboxProps={{ withinPortal: true }}
            aria-label={t("Period unit")}
          />
        </Group>
      )}
      {value.mode === "fixed" && (
        <Suspense fallback={<Skeleton height={36} width={200} />}>
          <DateInput
            value={value.fixedDate}
            onChange={(d) => set({ fixedDate: d ? new Date(d) : null })}
            minDate={addDays(1)}
            placeholder={t("Pick a date")}
            size="sm"
            w={200}
            popoverProps={{ withinPortal: true }}
            aria-label={t("Expiry date")}
          />
        </Suspense>
      )}
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}
