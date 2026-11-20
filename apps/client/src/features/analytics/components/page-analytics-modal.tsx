import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Group, Loader, Modal, SegmentedControl, SimpleGrid, Stack, Text } from "@mantine/core";
import { getPageAnalytics } from "../services";
import { ViewsChart } from "./views-chart";
import { useTimeAgo } from "@/hooks/use-time-ago";

type Props = { pageId: string; opened: boolean; onClose: () => void };

// Who read this page and when.
export function PageAnalyticsModal({ pageId, opened, onClose }: Props) {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({ queryKey: ["analytics", "page", pageId, days], queryFn: () => getPageAnalytics(pageId, days), enabled: opened });
  return (
    <Modal opened={opened} onClose={onClose} title={t("Page analytics")} size="lg">
      <Stack gap="sm" data-testid="page-analytics">
        <SegmentedControl size="xs" value={String(days)} onChange={(v) => setDays(Number(v))} data={[{ value: "7", label: t("7 days") }, { value: "30", label: t("30 days") }, { value: "90", label: t("90 days") }]} w={260} />
        {isLoading && <Loader size="sm" />}
        {data && data.settings.enabled === false && (
          <Text size="sm" c="dimmed">
            {t("Page views are not counted in this workspace.")}
          </Text>
        )}
        {data && (
          <>
            <SimpleGrid cols={3}>
              <Stat label={t("Views")} value={data.views} />
              <Stat label={t("Readers")} value={data.uniqueViewers} />
              <Stat label={t("All time")} value={data.allTimeViews} />
            </SimpleGrid>
            <ViewsChart byDay={data.byDay} days={days} />
            {data.viewers.length > 0 && (
              <Stack gap={4}>
                <Text size="xs" fw={600} c="dimmed">
                  {t("Recent readers")}
                </Text>
                {data.viewers.map((v) => (
                  <ViewerRow key={v.userId} name={v.name} avatarUrl={v.avatarUrl} views={v.views} last={v.last} />
                ))}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap={0}>
      <Text size="xl" fw={600}>
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

function ViewerRow({ name, avatarUrl, views, last }: { name: string | null; avatarUrl: string | null; views: number; last: string }) {
  const { t } = useTranslation();
  const ago = useTimeAgo(last as unknown as Date);
  return (
    <Group gap="xs" wrap="nowrap">
      <Avatar src={avatarUrl ?? undefined} name={name ?? undefined} color="initials" size="sm" radius="xl" />
      <Text size="sm" style={{ flex: 1 }} truncate>
        {name ?? t("Someone")}
      </Text>
      <Text size="xs" c="dimmed">
        {t("{{count}} views", { count: views })} · {ago}
      </Text>
    </Group>
  );
}
