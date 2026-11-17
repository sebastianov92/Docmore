import { ActionIcon, Badge, Group, Menu, Table, Text } from "@mantine/core";
import { IconDots, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IApiKey } from "@/features/api-key/types/api-key.types.ts";
import { ApiKeyScopeBadges } from "./api-key-scope-badges.tsx";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import NoTableResults from "@/components/common/no-table-results";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale.ts";

interface ApiKeyTableProps {
  apiKeys: IApiKey[];
  showUserColumn?: boolean;
  onRename: (apiKey: IApiKey) => void;
  onRevoke: (apiKey: IApiKey) => void;
}

export function ApiKeyTable({
  apiKeys,
  showUserColumn = false,
  onRename,
  onRevoke,
}: ApiKeyTableProps) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();

  const formatDate = (value: string | null) =>
    value ? formatLocalized(value, "MMM dd, yyyy", "PP", locale) : t("Never");

  const hasExpired = (value: string | null) =>
    !!value && new Date(value).getTime() < Date.now();

  const columns = showUserColumn ? 7 : 6;

  return (
    <Table.ScrollContainer minWidth={640}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Name")}</Table.Th>
            {showUserColumn && <Table.Th>{t("User")}</Table.Th>}
            <Table.Th>{t("Permissions")}</Table.Th>
            <Table.Th>{t("Last used")}</Table.Th>
            <Table.Th>{t("Expires")}</Table.Th>
            <Table.Th>{t("Created")}</Table.Th>
            <Table.Th aria-label={t("Actions")} />
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          {apiKeys.length === 0 ? (
            <NoTableResults colSpan={columns} />
          ) : (
            apiKeys.map((apiKey) => {
              const expired = hasExpired(apiKey.expiresAt);
              return (
                <Table.Tr key={apiKey.id}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text fz="sm" fw={500} lineClamp={1}>
                        {apiKey.name}
                      </Text>
                      {expired && (
                        <Badge color="red" variant="light" radius="sm">
                          {t("Expired")}
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>

                  {showUserColumn && (
                    <Table.Td>
                      {apiKey.creator ? (
                        <Group gap={6} wrap="nowrap">
                          <CustomAvatar
                            avatarUrl={apiKey.creator.avatarUrl}
                            name={apiKey.creator.name}
                            size="sm"
                          />
                          <Text fz="sm" lineClamp={1}>
                            {apiKey.creator.name}
                          </Text>
                        </Group>
                      ) : (
                        <Text fz="sm" c="dimmed">
                          {t("Unknown")}
                        </Text>
                      )}
                    </Table.Td>
                  )}

                  <Table.Td>
                    <ApiKeyScopeBadges scopes={apiKey.scopes ?? []} />
                  </Table.Td>

                  <Table.Td>
                    <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(apiKey.lastUsedAt)}
                    </Text>
                  </Table.Td>

                  <Table.Td>
                    <Text fz="sm" c={expired ? "red" : undefined} style={{ whiteSpace: "nowrap" }}>
                      {formatDate(apiKey.expiresAt)}
                    </Text>
                  </Table.Td>

                  <Table.Td>
                    <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(apiKey.createdAt)}
                    </Text>
                  </Table.Td>

                  <Table.Td>
                    <Menu position="bottom-end" withinPortal shadow="md">
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t("API key actions")}
                        >
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconPencil size={16} />}
                          onClick={() => onRename(apiKey)}
                        >
                          {t("Rename")}
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={16} />}
                          onClick={() => onRevoke(apiKey)}
                        >
                          {t("Revoke")}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              );
            })
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
