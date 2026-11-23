import { useState } from "react";
import { ActionIcon, Alert, Anchor, Box, Button, Group, List, Modal, PasswordInput, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconBrandNotion, IconInfoCircle, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { timeAgo } from "@/lib/time";
import {
  createNotionConnection,
  deleteNotionConnection,
  NOTION_CONNECTIONS_KEY,
  NotionConnection,
  notionError,
  useNotionConnections,
} from "./notion-connections";

// Settings > Integrations: the connections to Notion this workspace keeps,
// so importing from Notion does not ask for the secret every time.
export function NotionConnectionsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useNotionConnections();
  const [adding, setAdding] = useState(false);
  const items = data?.items ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => deleteNotionConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTION_CONNECTIONS_KEY });
      notifications.show({ message: t("Connection removed") });
    },
    onError: (err) => notifications.show({ message: getApiErrorMessage(err, t("Could not remove the connection")), color: "red" }),
  });
  const confirmRemove = (connection: NotionConnection) =>
    modals.openConfirmModal({
      title: t("Remove “{{name}}”", { name: connection.name }),
      centered: true,
      children: (
        <Text size="sm">
          {t("Imports will stop being able to use it. What was already imported stays. The connection itself is removed in Notion, not here.")}
        </Text>
      ),
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(connection.id),
    });

  return (
    <Box py="sm" px="xs" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }} data-testid="notion-connections">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <IconBrandNotion size={28} stroke={1.5} />
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500}>
              Notion
            </Text>
            <Text size="xs" c="dimmed">
              {t("Connections kept to import from Notion without pasting the secret each time.")}
            </Text>
          </Stack>
        </Group>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} style={{ flexShrink: 0 }} data-testid="notion-connection-add">
          {t("Add connection")}
        </Button>
      </Group>

      {!isLoading && items.length > 0 && (
        <Stack gap={6} mt="sm" ml={40}>
          {items.map((connection) => (
            <Group
              key={connection.id}
              justify="space-between"
              wrap="nowrap"
              px="sm"
              py={8}
              style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}
              data-testid="notion-connection-row"
            >
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {connection.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {[
                    connection.account && connection.account !== connection.name ? connection.account : null,
                    connection.addedBy ? t("Added by {{name}}", { name: connection.addedBy }) : null,
                    connection.lastUsedAt ? t("Last used {{when}}", { when: timeAgo(new Date(connection.lastUsedAt)) }) : t("Not used yet"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </Stack>
              <Tooltip label={t("Remove")} withArrow>
                <ActionIcon variant="subtle" color="gray" onClick={() => confirmRemove(connection)} aria-label={t("Remove “{{name}}”", { name: connection.name })} data-testid="notion-connection-remove">
                  <IconTrash size={16} stroke={1.6} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      )}

      <AddNotionConnectionModal opened={adding} onClose={() => setAdding(false)} />
    </Box>
  );
}

// The secret is tried against Notion before it is kept.
export function AddNotionConnectionModal({ opened, onClose, onAdded }: { opened: boolean; onClose: () => void; onAdded?: (connection: NotionConnection) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    // nothing of the secret stays on the screen once it closes
    setName("");
    setToken("");
    setError(null);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => createNotionConnection({ token: token.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
    onSuccess: (connection) => {
      queryClient.invalidateQueries({ queryKey: NOTION_CONNECTIONS_KEY });
      notifications.show({ message: t("Connection “{{name}}” added", { name: connection.name }) });
      onAdded?.(connection);
      close();
    },
    onError: (err) => setError(notionError(getApiErrorMessage(err, t("Could not reach Notion")), t)),
  });
  return (
    <Modal opened={opened} onClose={close} title={t("Add a Notion connection")} size="lg" data-testid="notion-connection-modal">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" icon={<IconInfoCircle size={16} />} data-testid="notion-connection-error">
            {error}
          </Alert>
        )}
        <List size="sm" spacing={6} type="ordered">
          <List.Item>
            {t("In Notion, create a connection and copy its secret:")}{" "}
            <Anchor href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer" size="sm">
              notion.so/profile/integrations
            </Anchor>
          </List.Item>
          <List.Item>{t("Share with that connection each page you want to import: ••• > Connections on the page. Its sub-pages come with it.")}</List.Item>
          <List.Item>{t("Paste the secret here. It is kept encrypted and never shown again.")}</List.Item>
        </List>
        <TextInput
          label={t("Name")}
          description={t("Left empty, it takes the name the connection has in Notion.")}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={80}
          data-testid="notion-connection-name"
        />
        <PasswordInput
          label={t("Secret of the connection")}
          placeholder="ntn_…"
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          autoComplete="off"
          data-testid="notion-connection-token"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={token.trim().length < 20} data-testid="notion-connection-save">
            {t("Check and save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
