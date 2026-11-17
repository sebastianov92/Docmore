import { ActionIcon, Badge, Loader, Table, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useOAuthGrantsQuery, useRevokeOAuthGrantMutation } from "../queries";
import { OAuthGrant } from "../types";

// Hosts tell the app apart; the full callback shows on the consent screen.
function callbackHosts(uris: string[]): string {
  const hosts = uris.map((uri) => {
    try {
      const url = new URL(uri);
      return url.protocol === "http:" || url.protocol === "https:" ? url.host : url.protocol;
    } catch {
      return uri;
    }
  });
  return Array.from(new Set(hosts)).join(", ");
}

// The apps (MCP clients) this user let into their account, with revoke.
export function ConnectedApps() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useOAuthGrantsQuery();
  const revoke = useRevokeOAuthGrantMutation();
  const grants = data ?? [];

  const confirmRevoke = (grant: OAuthGrant) =>
    modals.openConfirmModal({
      title: t("Revoke access"),
      centered: true,
      children: (
        <Text size="sm">
          {t("{{name}} will no longer be able to act on your account. You can connect it again later.", {
            name: grant.clientName,
          })}
        </Text>
      ),
      labels: { confirm: t("Revoke access"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revoke.mutate(grant.id),
    });

  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "medium" }) : t("Never");

  return (
    <div>
      <Text size="md" fw={500}>
        {t("Connected apps")}
      </Text>
      <Text size="sm" c="dimmed" mb="sm">
        {t("AI assistants and tools you connected through the MCP server, acting as you.")}
      </Text>
      {isLoading ? (
        <Loader size="sm" />
      ) : grants.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("No apps connected.")}
        </Text>
      ) : (
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("App")}</Table.Th>
              <Table.Th>{t("Can")}</Table.Th>
              <Table.Th>{t("Connected")}</Table.Th>
              <Table.Th>{t("Last used")}</Table.Th>
              <Table.Th aria-label={t("Actions")} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {grants.map((grant) => (
              <Table.Tr key={grant.id}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {grant.clientName}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                    {callbackHosts(grant.redirectUris)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={grant.scopes.includes("write") ? "orange" : "blue"}>
                    {grant.scopes.includes("write") ? t("Read and write") : t("Read")}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{when(grant.createdAt)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{when(grant.lastUsedAt)}</Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={t("Revoke access")}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t("Revoke access for {{name}}", { name: grant.clientName })}
                      onClick={() => confirmRevoke(grant)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}
