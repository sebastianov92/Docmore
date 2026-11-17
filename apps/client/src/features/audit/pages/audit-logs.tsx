import { lazy, Suspense, useMemo, useState } from "react";
import { Button, Divider, Group, Select, Skeleton, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import Paginate from "@/components/common/paginate.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate.tsx";
import { useAuditLogsQuery } from "@/features/audit/queries/audit-query";
import { IAuditLogParams } from "@/features/audit/types/audit.types";
import { EVENT_FILTER_GROUPS, eventLabel } from "@/features/audit/lib/audit-events";
import { toDateParam } from "@/features/audit/lib/audit-time";
import AuditLogTable from "@/features/audit/components/audit-log-table";
import AuditRetentionSetting from "@/features/audit/components/audit-retention-setting";

// Loaded on demand: the date picker is heavy and only this page uses a range.
const DatePickerInput = lazy(() =>
  import("@mantine/dates").then((m) => ({ default: m.DatePickerInput })),
);

const PAGE_SIZE = 50;
type DateRange = [Date | null, Date | null];

// Settings > Audit logs. Owner only; the server refuses everyone else.
export default function AuditLogs() {
  const { t } = useTranslation();
  const { isOwner } = useUserRole();
  const { cursor, goNext, goPrev, resetCursor } = useCursorPaginate();
  const [event, setEvent] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>([null, null]);

  const params: IAuditLogParams = useMemo(
    () => ({
      cursor,
      limit: PAGE_SIZE,
      event: event ?? undefined,
      startDate: toDateParam(range[0]),
      endDate: toDateParam(range[1]),
    }),
    [cursor, event, range],
  );
  const { data, isLoading, isFetching } = useAuditLogsQuery(params);

  if (!isOwner) {
    return null;
  }

  const eventOptions = EVENT_FILTER_GROUPS.map((group) => ({
    group: t(group.group),
    items: group.events.map((value) => ({ value, label: t(eventLabel(value)) })),
  }));

  const hasFilters = Boolean(event || range[0] || range[1]);
  const clearFilters = () => {
    setEvent(null);
    setRange([null, null]);
    resetCursor();
  };

  return (
    <>
      <DocumentTitle title={t("Audit logs")} />
      <SettingsTitle title={t("Audit logs")} />

      <Text size="sm" c="dimmed" mb="md">
        {t("Who did what in this workspace: sign-ins, membership, spaces, pages, sharing and settings. Newest first.")}
      </Text>

      <AuditRetentionSetting />
      <Divider my="lg" />

      <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
        <Select
          label={t("Event")}
          placeholder={t("All events")}
          data={eventOptions}
          value={event}
          onChange={(value) => {
            setEvent(value);
            resetCursor();
          }}
          clearable
          searchable
          nothingFoundMessage={t("No such event")}
          w={260}
          size="sm"
          comboboxProps={{ withinPortal: true }}
        />
        <Suspense fallback={<Skeleton height={36} width={260} />}>
          <DatePickerInput
            type="range"
            label={t("Date range")}
            placeholder={t("Any time")}
            value={range}
            onChange={(value) => {
              setRange(normalizeRange(value));
              resetCursor();
            }}
            clearable
            allowSingleDateInRange
            maxDate={new Date()}
            valueFormat="DD MMM YYYY"
            w={260}
            size="sm"
            popoverProps={{ withinPortal: true }}
          />
        </Suspense>
        {hasFilters && (
          <Button variant="subtle" size="sm" onClick={clearFilters}>
            {t("Clear filters")}
          </Button>
        )}
        {isFetching && !isLoading && (
          <Text size="xs" c="dimmed">
            {t("Refreshing…")}
          </Text>
        )}
      </Group>

      <AuditLogTable items={data?.items} isLoading={isLoading} />

      <Paginate
        hasPrevPage={Boolean(data?.meta?.hasPrevPage)}
        hasNextPage={Boolean(data?.meta?.hasNextPage)}
        onPrev={goPrev}
        onNext={() => goNext(data?.meta?.nextCursor)}
      />
    </>
  );
}

// Mantine 9 may hand back strings or Dates depending on the picker config.
function normalizeRange(value: unknown): DateRange {
  if (!Array.isArray(value)) return [null, null];
  const [a, b] = value as Array<string | Date | null>;
  const toDate = (v: string | Date | null) => (v ? new Date(v) : null);
  return [toDate(a), toDate(b)];
}
