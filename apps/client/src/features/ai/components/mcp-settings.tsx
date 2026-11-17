import { ActionIcon, Code, CopyButton, Group, List, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { getApiErrorMessage } from "@/lib/api-error";
import { getAppUrl } from "@/lib/config.ts";
import { ResponsiveSettingsContent, ResponsiveSettingsControl, ResponsiveSettingsRow } from "@/components/ui/responsive-settings-row";

// Settings > AI: the MCP server switch, its address and whether API keys
// may be used with it.
export function McpSettings() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const enabled = workspace?.settings?.ai?.mcp === true;
  const enforceOAuth = workspace?.settings?.ai?.enforceMcpOauth === true;
  const url = `${getAppUrl()}/mcp`;

  const toggle = async (key: "mcpEnabled" | "enforceMcpOauth", value: boolean) => {
    try {
      const updated = await updateWorkspace({ [key]: value } as any);
      setWorkspace(updated);
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to update setting")), color: "red" });
    }
  };

  return (
    <Stack gap="md">
      <ResponsiveSettingsRow>
        <ResponsiveSettingsContent>
          <Text size="md">{t("MCP server")}</Text>
          <Text size="sm" c="dimmed">
            {t("Lets Claude, Cursor, ChatGPT and other assistants search, read and write pages as the member who connects them.")}
          </Text>
        </ResponsiveSettingsContent>
        <ResponsiveSettingsControl>
          <Switch checked={enabled} onChange={(e) => toggle("mcpEnabled", e.currentTarget.checked)} aria-label={t("Toggle MCP server")} />
        </ResponsiveSettingsControl>
      </ResponsiveSettingsRow>

      {enabled && (
        <>
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Server address")}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput value={url} readOnly style={{ flex: 1 }} aria-label={t("MCP server address")} />
              <CopyButton value={url} timeout={2000}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? t("Copied") : t("Copy")} withArrow>
                    <ActionIcon color={copied ? "teal" : "gray"} variant="subtle" onClick={copy} aria-label={t("Copy address")}>
                      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
            <Text size="sm" c="dimmed" mt="xs">
              {t("Add it as a remote MCP server; the assistant opens a sign-in page here and you choose what it may do. Claude Code:")}{" "}
              <Code>claude mcp add --transport http docmore {url}</Code>
            </Text>
          </div>

          <ResponsiveSettingsRow>
            <ResponsiveSettingsContent>
              <Text size="md">{t("Sign-in only")}</Text>
              <Text size="sm" c="dimmed">
                {t("Assistants must connect through the sign-in page. Off, an API key works as a bearer token too.")}
              </Text>
            </ResponsiveSettingsContent>
            <ResponsiveSettingsControl>
              <Switch
                checked={enforceOAuth}
                onChange={(e) => toggle("enforceMcpOauth", e.currentTarget.checked)}
                aria-label={t("Toggle sign-in only for MCP")}
              />
            </ResponsiveSettingsControl>
          </ResponsiveSettingsRow>

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Tools")}
            </Text>
            <List size="sm" spacing={2}>
              <List.Item>
                <Text size="sm" c="dimmed" span>
                  get_current_user, list_spaces, list_pages, search_pages, get_page
                </Text>
              </List.Item>
              <List.Item>
                <Text size="sm" c="dimmed" span>
                  create_page, update_page ({t("only with write access, and never while the chat is read-only")})
                </Text>
              </List.Item>
            </List>
          </div>
        </>
      )}
    </Stack>
  );
}
