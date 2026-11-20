import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Code, Group, MultiSelect, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconHistory, IconPlugConnected, IconRefresh, IconTrash } from "@tabler/icons-react";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import CopyTextButton from "@/components/common/copy.tsx";
import { createWebhook, deleteWebhook, IWebhook, listWebhookDeliveries, listWebhooks, testWebhook, updateWebhook } from "@/features/webhook/services";
import { getApiErrorMessage } from "@/lib/api-error";

// Outgoing webhooks: signed POSTs for pages, spaces and base rows.
export default function WebhooksSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["webhooks"], queryFn: listWebhooks });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });
  const create = useMutation({
    mutationFn: () => createWebhook({ name, url, events: events.length ? events : undefined }),
    onSuccess: (w) => {
      setName("");
      setUrl("");
      setEvents([]);
      setRevealed(w.secret ? { id: w.id, secret: w.secret } : null);
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: updateWebhook,
    onSuccess: (w) => {
      if (w.secret) setRevealed({ id: w.id, secret: w.secret });
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: deleteWebhook, onSuccess: refresh, onError: fail });
  const test = useMutation({ mutationFn: testWebhook, onSuccess: () => notifications.show({ message: t("Test delivery queued") }), onError: fail });
  const { data: deliveries } = useQuery({ queryKey: ["webhook-deliveries", deliveriesFor], queryFn: () => listWebhookDeliveries(deliveriesFor as string), enabled: Boolean(deliveriesFor) });
  const eventOptions = (data?.events ?? []).map((e) => ({ value: e, label: e }));

  return (
    <>
      <DocumentTitle title={t("Webhooks")} />
      <SettingsTitle title={t("Webhooks")} />
      <Stack gap="lg" maw={900}>
        <Text size="sm" c="dimmed">
          {t("Docmore posts a JSON body to each URL when the chosen events happen, signed with HMAC-SHA256 in the x-docmore-signature header (v1=hex of '<timestamp>.<body>'). Failed deliveries retry five times; twenty failures in a row turn a webhook off.")}
        </Text>
        {revealed && (
          <Group gap="xs" wrap="nowrap" data-testid="webhook-secret">
            <Text size="sm">{t("Signing secret (shown once):")}</Text>
            <Code>{revealed.secret}</Code>
            <CopyTextButton text={revealed.secret} />
          </Group>
        )}
        <Table fz="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Name")}</Table.Th>
              <Table.Th>{t("Events")}</Table.Th>
              <Table.Th>{t("Status")}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(data?.items ?? []).map((w: IWebhook) => (
              <Table.Tr key={w.id} data-testid="webhook-row">
                <Table.Td>
                  <Text fw={500}>{w.name}</Text>
                  <Text size="xs" c="dimmed" truncate maw={320}>
                    {w.url}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {w.events.includes("*") ? t("All events") : w.events.join(", ")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <Switch size="xs" checked={w.enabled} onChange={(e) => update.mutate({ webhookId: w.id, enabled: e.currentTarget.checked })} aria-label={t("Enabled")} />
                    {w.lastError && (
                      <Badge size="xs" color="red" variant="light" style={{ textTransform: "none" }}>
                        {w.failures} · {w.lastError}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap" justify="flex-end">
                    <Tooltip label={t("Send a test")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => test.mutate(w.id)} aria-label={t("Send a test")}>
                        <IconPlugConnected size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("Rotate secret")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => update.mutate({ webhookId: w.id, rotateSecret: true })} aria-label={t("Rotate secret")}>
                        <IconRefresh size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t("Deliveries")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setDeliveriesFor(deliveriesFor === w.id ? null : w.id)} aria-label={t("Deliveries")}>
                        <IconHistory size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(w.id)} aria-label={t("Delete")}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {deliveriesFor && (
          <Stack gap={4} data-testid="webhook-deliveries">
            <Title order={6}>{t("Recent deliveries")}</Title>
            {(deliveries?.items ?? []).map((d) => (
              <Group key={d.id} gap="xs" wrap="nowrap">
                <Badge size="xs" color={d.ok ? "green" : d.status === null && !d.error ? "gray" : "red"} variant="light" style={{ textTransform: "none" }}>
                  {d.ok ? t("ok") : d.error ? t("failed") : t("pending")}
                </Badge>
                <Text size="xs">{d.event}</Text>
                <Text size="xs" c="dimmed">
                  {d.status ?? "–"} · {d.durationMs ?? "–"} ms · {t("attempt")} {d.attempt} · {new Date(d.createdAt).toLocaleString()}
                </Text>
                {d.error && (
                  <Text size="xs" c="red" truncate>
                    {d.error}
                  </Text>
                )}
              </Group>
            ))}
            {deliveriesFor && (deliveries?.items ?? []).length === 0 && (
              <Text size="xs" c="dimmed">
                {t("Nothing delivered yet.")}
              </Text>
            )}
          </Stack>
        )}
        <Group gap="xs" align="flex-end" wrap="wrap">
          <TextInput size="xs" w={160} label={t("Name")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput size="xs" style={{ flex: 1, minWidth: 240 }} label={t("URL")} placeholder="https://example.com/hooks/docmore" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
          <MultiSelect size="xs" w={260} label={t("Events")} placeholder={t("All events")} data={eventOptions} value={events} onChange={setEvents} clearable searchable />
          <Button size="xs" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !/^https?:\/\//.test(url)} data-testid="webhook-create">
            {t("Add webhook")}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
