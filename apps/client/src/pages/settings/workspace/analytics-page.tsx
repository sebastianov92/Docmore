import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Anchor, Group, Loader, SegmentedControl, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { getWorkspaceAnalytics } from "@/features/analytics/services";
import { ViewsChart } from "@/features/analytics/components/views-chart";
import { buildPageUrl } from "@/features/page/page.utils.ts";

// What gets read and what is dead across the workspace.
export default function AnalyticsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({ queryKey: ["analytics", "workspace", days], queryFn: () => getWorkspaceAnalytics(days) });
  return (
    <>
      <DocumentTitle title={t("Analytics")} />
      <SettingsTitle title={t("Analytics")} />
      <Stack gap="lg" maw={900} data-testid="workspace-analytics">
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
              <Stat label={t("Active readers")} value={data.activeViewers} />
              <Stat label={t("Pages read")} value={data.pagesViewed} />
            </SimpleGrid>
            <ViewsChart byDay={data.byDay} days={days} />
            <Title order={5}>{t("Most read")}</Title>
            <Table fz="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Page")}</Table.Th>
                  <Table.Th>{t("Space")}</Table.Th>
                  <Table.Th ta="right">{t("Views")}</Table.Th>
                  <Table.Th ta="right">{t("Readers")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.topPages.map((p) => (
                  <Table.Tr key={p.pageId}>
                    <Table.Td>
                      <Anchor component={Link} to={buildPageUrl(p.spaceSlug, p.slugId, p.title ?? "")} size="sm">
                        {p.title || t("Untitled")}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{p.spaceName}</Table.Td>
                    <Table.Td ta="right">{p.views}</Table.Td>
                    <Table.Td ta="right">{p.viewers}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group gap="xs">
              <Title order={5}>{t("Possibly dead")}</Title>
              <Text size="xs" c="dimmed">
                {t("Not edited and not read in 90 days")}
              </Text>
            </Group>
            <Table fz="sm" highlightOnHover>
              <Table.Tbody>
                {data.stalePages.map((p) => (
                  <Table.Tr key={p.pageId}>
                    <Table.Td>
                      <Anchor component={Link} to={buildPageUrl(p.spaceSlug, p.slugId, p.title ?? "")} size="sm">
                        {p.title || t("Untitled")}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{p.spaceName}</Table.Td>
                    <Table.Td ta="right">
                      <Text size="xs" c="dimmed">
                        {t("edited")} {new Date(p.updatedAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {data.stalePages.length === 0 && (
                  <Table.Tr>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {t("Nothing looks abandoned.")}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </>
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
