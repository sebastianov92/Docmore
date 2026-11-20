import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Group, PasswordInput, Select, Stack, Switch, Table, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay, IconPlugConnected, IconTrash } from "@tabler/icons-react";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { createSiemDestination, deleteSiemDestination, ISiemDestination, listSiemDestinations, runSiemDestination, testSiemDestination, updateSiemDestination } from "@/features/siem/services";
import { getApiErrorMessage } from "@/lib/api-error";

// Where the audit trail is shipped: a webhook, Splunk HEC or Elasticsearch.
export default function SiemSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["siem-destinations"], queryFn: listSiemDestinations });
  const [type, setType] = useState<"webhook" | "splunk" | "elastic">("webhook");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [index, setIndex] = useState("docmore-audit");
  const [token, setToken] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["siem-destinations"] });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });
  const create = useMutation({
    mutationFn: () => createSiemDestination({ type, name, config: { url, ...(type === "elastic" ? { index } : {}) }, secrets: token ? { token } : undefined }),
    onSuccess: () => {
      setName("");
      setUrl("");
      setToken("");
      refresh();
      notifications.show({ message: t("Destination added") });
    },
    onError: fail,
  });
  const update = useMutation({ mutationFn: updateSiemDestination, onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: deleteSiemDestination, onSuccess: refresh, onError: fail });
  const test = useMutation({ mutationFn: testSiemDestination, onSuccess: () => notifications.show({ message: t("Test event sent") }), onError: fail });
  const run = useMutation({ mutationFn: runSiemDestination, onSuccess: (r) => { refresh(); notifications.show({ message: t("{{count}} events sent", { count: r.sent }) }); }, onError: fail });

  return (
    <>
      <DocumentTitle title={t("SIEM export")} />
      <SettingsTitle title={t("SIEM export")} />
      <Stack gap="lg" maw={900}>
        <Text size="sm" c="dimmed">
          {t("Every minute, new audit log rows are sent to each destination. After a failure the next try waits longer; a destination failing for 24 hours is turned off and the owners are told.")}
        </Text>
        <Table fz="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Name")}</Table.Th>
              <Table.Th>{t("Type")}</Table.Th>
              <Table.Th>{t("Status")}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(data?.items ?? []).map((d: ISiemDestination) => (
              <Table.Tr key={d.id} data-testid="siem-row">
                <Table.Td>
                  <Text fw={500}>{d.name}</Text>
                  <Text size="xs" c="dimmed" truncate maw={320}>
                    {d.config?.url}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="light" style={{ textTransform: "none" }}>
                    {d.type}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <Switch size="xs" checked={d.enabled} onChange={(e) => update.mutate({ destinationId: d.id, enabled: e.currentTarget.checked })} aria-label={t("Enabled")} />
                    <Badge size="xs" color={d.status === "ok" ? "green" : d.status === "failing" ? "orange" : "gray"} variant="light" style={{ textTransform: "none" }}>
                      {d.status}
                    </Badge>
                    {d.lastDeliveredAt && (
                      <Text size="xs" c="dimmed">
                        {t("last")} {new Date(d.lastDeliveredAt).toLocaleString()}
                      </Text>
                    )}
                    {d.lastError && (
                      <Text size="xs" c="red" truncate maw={240}>
                        {d.lastError}
                      </Text>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap" justify="flex-end">
                    <Tooltip label={t("Send a test event")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => test.mutate(d.id)} aria-label={t("Send a test event")}>
                        <IconPlugConnected size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("Send pending events now")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => run.mutate(d.id)} aria-label={t("Send pending events now")}>
                        <IconPlayerPlay size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(d.id)} aria-label={t("Delete")}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select size="xs" w={130} label={t("Type")} data={[{ value: "webhook", label: "Webhook" }, { value: "splunk", label: "Splunk HEC" }, { value: "elastic", label: "Elasticsearch" }]} value={type} onChange={(v) => v && setType(v as typeof type)} allowDeselect={false} />
          <TextInput size="xs" w={150} label={t("Name")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput size="xs" style={{ flex: 1, minWidth: 220 }} label={t("URL")} placeholder={type === "splunk" ? "https://splunk.example.com:8088" : type === "elastic" ? "https://elastic.example.com:9200" : "https://siem.example.com/ingest"} value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
          {type === "elastic" && <TextInput size="xs" w={150} label={t("Index")} value={index} onChange={(e) => setIndex(e.currentTarget.value)} />}
          <PasswordInput size="xs" w={200} label={type === "splunk" ? t("HEC token") : type === "elastic" ? t("API key") : t("Bearer token (optional)")} value={token} onChange={(e) => setToken(e.currentTarget.value)} />
          <Button size="xs" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !/^https?:\/\//.test(url)} data-testid="siem-create">
            {t("Add destination")}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
