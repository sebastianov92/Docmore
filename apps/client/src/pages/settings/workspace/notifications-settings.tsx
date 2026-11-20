import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Group, MultiSelect, Select, Stack, Switch, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlugConnected, IconTrash } from "@tabler/icons-react";
import { useAtom } from "jotai";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { addNotificationWebhook, listNotificationWebhooks, removeNotificationWebhook, testNotificationWebhook } from "@/features/notification/services/notification-webhooks";
import { getApiErrorMessage } from "@/lib/api-error";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service";

const EVENT_OPTIONS = [
  { value: "page.updated", label: "Page updated" },
  { value: "page.user_mention", label: "Mention on a page" },
  { value: "comment.created", label: "Comment" },
  { value: "comment.user_mention", label: "Mention in a comment" },
  { value: "comment.resolved", label: "Comment resolved" },
  { value: "page.permission_granted", label: "Access granted" },
  { value: "page.approval_requested", label: "Approval requested" },
  { value: "page.verified", label: "Page verified" },
  { value: "base.automation", label: "Base automation" },
];

// Slack / Teams incoming webhooks that mirror notifications, and the
// analytics switches.
export default function NotificationsSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { data } = useQuery({ queryKey: ["notification-webhooks"], queryFn: listNotificationWebhooks });
  const [type, setType] = useState<"slack" | "teams">("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["notification-webhooks"] });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });
  const add = useMutation({
    mutationFn: () => addNotificationWebhook({ type, name: name || undefined, url, events: events.length ? events : undefined }),
    onSuccess: () => {
      setName("");
      setUrl("");
      setEvents([]);
      refresh();
      notifications.show({ message: t("Webhook added") });
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: removeNotificationWebhook, onSuccess: refresh, onError: fail });
  const test = useMutation({ mutationFn: testNotificationWebhook, onSuccess: () => notifications.show({ message: t("Test message sent") }), onError: fail });
  const analytics = ((workspace?.settings as any)?.analytics ?? {}) as { enabled?: boolean; anonymous?: boolean };
  const saveAnalytics = useMutation({
    mutationFn: (patch: { analyticsEnabled?: boolean; analyticsAnonymous?: boolean }) => updateWorkspace(patch as any),
    onSuccess: (ws) => setWorkspace(ws as any),
    onError: fail,
  });

  return (
    <>
      <DocumentTitle title={t("Notifications")} />
      <SettingsTitle title={t("Notifications")} />
      <Stack gap="lg" maw={720}>
        <Stack gap="xs">
          <Title order={4}>{t("Slack and Teams")}</Title>
          <Text size="sm" c="dimmed">
            {t("Every notification Docmore sends is also posted to these incoming webhooks. Create one in Slack (Incoming Webhooks) or Teams (Workflows / Incoming Webhook) and paste its address.")}
          </Text>
          {(data?.items ?? []).map((h) => (
            <Group key={h.id} justify="space-between" wrap="nowrap" data-testid="notification-webhook">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge size="xs" variant="light" style={{ textTransform: "none" }}>
                  {h.type === "slack" ? "Slack" : "Teams"}
                </Badge>
                <Text size="sm" fw={500} truncate>
                  {h.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {h.url} · {h.events.includes("*") ? t("all events") : t("{{count}} events", { count: h.events.length })}
                </Text>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Tooltip label={t("Send a test")}>
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => test.mutate(h.id)} loading={test.isPending && test.variables === h.id} aria-label={t("Send a test")}>
                    <IconPlugConnected size={14} />
                  </ActionIcon>
                </Tooltip>
                <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(h.id)} aria-label={t("Remove")}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>
          ))}
          <Group gap="xs" align="flex-end" wrap="wrap">
            <Select size="xs" w={110} data={[{ value: "slack", label: "Slack" }, { value: "teams", label: "Teams" }]} value={type} onChange={(v) => v && setType(v as "slack" | "teams")} allowDeselect={false} />
            <TextInput size="xs" w={140} placeholder={t("Name")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <TextInput size="xs" style={{ flex: 1, minWidth: 220 }} placeholder="https://hooks.slack.com/services/…" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
            <MultiSelect size="xs" w={220} placeholder={t("All events")} data={EVENT_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} value={events} onChange={setEvents} clearable />
            <Button size="xs" onClick={() => add.mutate()} loading={add.isPending} disabled={!/^https:\/\//.test(url)} data-testid="webhook-add">
              {t("Add")}
            </Button>
          </Group>
        </Stack>
        <Stack gap="xs">
          <Title order={4}>{t("Analytics")}</Title>
          <Switch
            label={t("Count page views")}
            description={t("Who opened what, per day. Turn off to keep no counts at all.")}
            checked={analytics.enabled !== false}
            onChange={(e) => saveAnalytics.mutate({ analyticsEnabled: e.currentTarget.checked })}
          />
          <Switch
            label={t("Do not record who viewed")}
            description={t("Counts only; viewers are not named.")}
            checked={analytics.anonymous === true}
            disabled={analytics.enabled === false}
            onChange={(e) => saveAnalytics.mutate({ analyticsAnonymous: e.currentTarget.checked })}
          />
        </Stack>
      </Stack>
    </>
  );
}
