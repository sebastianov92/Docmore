import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Group, MultiSelect, PasswordInput, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlugConnected, IconTrash } from "@tabler/icons-react";
import { createMcpServer, deleteMcpServer, IMcpServer, listMcpServers, MCP_SERVERS_KEY, testMcpServer, updateMcpServer } from "@/features/ai/mcp-client/services";
import { getApiErrorMessage } from "@/lib/api-error";

// MCP servers the chat may call: the workspace's (admins) or this person's.
export function McpServersPanel({ scope }: { scope: "workspace" | "personal" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: MCP_SERVERS_KEY, queryFn: listMcpServers });
  const items = (data?.items ?? []).filter((s) => s.scope === scope);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authValue, setAuthValue] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
  const fail = (err: unknown) => notifications.show({ color: "red", message: getApiErrorMessage(err) });
  const create = useMutation({
    mutationFn: () => createMcpServer({ name, url, scope, authHeader: authValue ? authHeader : undefined, authValue: authValue || undefined }),
    onSuccess: (s) => {
      setName("");
      setUrl("");
      setAuthValue("");
      refresh();
      notifications.show({ message: s.lastError ? t("Added, but it could not be reached: {{error}}", { error: s.lastError }) : t("Connected: {{count}} tools", { count: s.tools.length }), color: s.lastError ? "yellow" : undefined });
    },
    onError: fail,
  });
  const update = useMutation({ mutationFn: updateMcpServer, onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: deleteMcpServer, onSuccess: refresh, onError: fail });
  const test = useMutation({
    mutationFn: testMcpServer,
    onSuccess: (s) => {
      refresh();
      notifications.show({ message: t("Connected: {{count}} tools", { count: s.tools.length }) });
    },
    onError: fail,
  });

  return (
    <Stack gap="md" data-testid={`mcp-servers-${scope}`}>
      <Text size="sm" c="dimmed">
        {scope === "workspace"
          ? t("Everyone's chat can call these servers' tools. Tools that only read run on their own; the rest wait for the person's approval unless you turn that off.")
          : t("Only your chat can call these. The server must be reachable from the internet; its tools that change things ask you first.")}
      </Text>
      {items.map((s: IMcpServer) => (
        <div key={s.id} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: "10px 12px" }} data-testid="mcp-server-row">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <IconPlugConnected size={14} />
                <Text fw={500} truncate>
                  {s.name}
                </Text>
                {s.lastError ? (
                  <Badge size="xs" color="red" variant="light" style={{ textTransform: "none" }}>
                    {t("unreachable")}
                  </Badge>
                ) : (
                  <Badge size="xs" variant="light" style={{ textTransform: "none" }}>
                    {t("{{count}} tools", { count: s.tools.length })}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed" truncate>
                {s.url}
                {s.hasAuth ? ` · ${s.authHeader}` : ""}
              </Text>
              {s.lastError && (
                <Text size="xs" c="red" truncate>
                  {s.lastError}
                </Text>
              )}
            </div>
            <Group gap={6} wrap="nowrap">
              <Tooltip label={t("Test the connection")}>
                <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => test.mutate(s.id)} loading={test.isPending} aria-label={t("Test the connection")}>
                  <IconPlugConnected size={14} />
                </ActionIcon>
              </Tooltip>
              <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(s.id)} aria-label={t("Delete")}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          </Group>
          <Group gap="lg" mt="xs" wrap="wrap">
            <Switch size="xs" label={t("Enabled")} checked={s.enabled} onChange={(e) => update.mutate({ serverId: s.id, enabled: e.currentTarget.checked })} />
            <Switch size="xs" label={t("Ask before tools that change things")} checked={s.requireConfirmation} onChange={(e) => update.mutate({ serverId: s.id, requireConfirmation: e.currentTarget.checked })} />
            {s.tools.length > 0 && (
              <MultiSelect
                size="xs"
                w={320}
                placeholder={t("All tools")}
                data={s.tools.map((tool) => ({ value: tool.name, label: tool.annotations?.readOnlyHint ? `${tool.name} (${t("read-only")})` : tool.name }))}
                value={s.allowedTools ?? []}
                onChange={(v) => update.mutate({ serverId: s.id, allowedTools: v.length ? v : null })}
                clearable
                searchable
                aria-label={t("Allowed tools")}
              />
            )}
          </Group>
        </div>
      ))}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <TextInput size="xs" w={140} label={t("Name")} placeholder="GitHub" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <TextInput size="xs" style={{ flex: 1, minWidth: 220 }} label={t("Server URL")} placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        <TextInput size="xs" w={130} label={t("Auth header")} value={authHeader} onChange={(e) => setAuthHeader(e.currentTarget.value)} />
        <PasswordInput size="xs" w={180} label={t("Token (optional)")} value={authValue} onChange={(e) => setAuthValue(e.currentTarget.value)} />
        <Button size="xs" onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !/^https?:\/\//.test(url)} data-testid="mcp-server-add">
          {t("Add server")}
        </Button>
      </Group>
    </Stack>
  );
}
