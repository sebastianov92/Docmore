import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Card,
  Group,
  Menu,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  IconCheck,
  IconDots,
  IconPencil,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import NoTableResults from "@/components/common/no-table-results";
import { OpenIdIcon } from "@/components/icons/openid-icon.tsx";
import { ISsoProvider } from "@/features/sso/types/sso.types.ts";
import { useDeleteSsoProviderMutation } from "@/features/sso/queries/sso-query.ts";
import SsoProviderModal from "./sso-provider-modal.tsx";
import classes from "./sso.module.css";

interface SsoProviderListProps {
  providers: ISsoProvider[];
  // Lets the parent open the editor right after creating a provider.
  editing: ISsoProvider | null;
  onEdit: (provider: ISsoProvider | null) => void;
}

function issuerHost(issuer: string | null): string | null {
  if (!issuer) return null;
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

export default function SsoProviderList({
  providers,
  editing,
  onEdit,
}: SsoProviderListProps) {
  const { t } = useTranslation();
  const deleteMutation = useDeleteSsoProviderMutation();
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  const confirmDelete = (provider: ISsoProvider) =>
    modals.openConfirmModal({
      title: t("Delete SSO provider"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            'Members who signed in through "{{name}}" keep their accounts but will need another way to log in.',
            { name: provider.name },
          )}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(provider.id),
    });

  const sorted = [...providers].sort((a, b) => {
    const enabledDiff = Number(b.isEnabled) - Number(a.isEnabled);
    if (enabledDiff !== 0) return enabledDiff;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <Card shadow="sm" radius="sm" withBorder p={0}>
        <Table.ScrollContainer minWidth={560}>
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Name")}</Table.Th>
                <Table.Th>{t("Type")}</Table.Th>
                <Table.Th>{t("Status")}</Table.Th>
                <Table.Th>{t("Allow signup")}</Table.Th>
                <Table.Th aria-label={t("Actions")} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sorted.length === 0 ? (
                <NoTableResults colSpan={5} text={t("No SSO providers found.")} />
              ) : (
                sorted.map((provider) => {
                  const host = issuerHost(provider.type === "saml" ? provider.samlUrl ?? null : provider.oidcIssuer);
                  return (
                    <Table.Tr
                      key={provider.id}
                      className={classes.providerRow}
                      onClick={() => onEdit(provider)}
                    >
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <OpenIdIcon size={18} />
                          <div>
                            <Text fz="sm" fw={500} lineClamp={1}>
                              {provider.name}
                            </Text>
                            <Text fz="xs" c="dimmed" lineClamp={1}>
                              {host ?? t("Not configured yet")}
                            </Text>
                          </div>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Badge color="gray" variant="light">
                          {provider.type === "saml" ? "SAML" : "OIDC"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={provider.isEnabled ? "blue" : "gray"}
                          variant="light"
                        >
                          {provider.isEnabled ? t("Active") : t("Inactive")}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <ThemeIcon
                          variant="light"
                          color={provider.allowSignup ? "blue" : "gray"}
                          size={24}
                          radius="xl"
                          aria-label={
                            provider.allowSignup
                              ? t("Signup allowed")
                              : t("Signup not allowed")
                          }
                        >
                          {provider.allowSignup ? (
                            <IconCheck size={16} />
                          ) : (
                            <IconX size={16} />
                          )}
                        </ThemeIcon>
                      </Table.Td>
                      <Table.Td onClick={(event) => event.stopPropagation()}>
                        <Group gap="xs" wrap="nowrap" justify="flex-end">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label={t("Edit {{name}}", { name: provider.name })}
                            onClick={() => onEdit(provider)}
                          >
                            <IconPencil size={16} />
                          </ActionIcon>
                          <Menu
                            opened={menuOpenFor === provider.id}
                            onChange={(opened) =>
                              setMenuOpenFor(opened ? provider.id : null)
                            }
                            position="bottom-end"
                            withinPortal
                          >
                            <Menu.Target>
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                aria-label={t("More actions for {{name}}", {
                                  name: provider.name,
                                })}
                              >
                                <IconDots size={16} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item
                                leftSection={<IconPencil size={16} />}
                                onClick={() => onEdit(provider)}
                              >
                                {t("Edit")}
                              </Menu.Item>
                              <Menu.Item
                                color="red"
                                leftSection={<IconTrash size={16} />}
                                onClick={() => confirmDelete(provider)}
                              >
                                {t("Delete")}
                              </Menu.Item>
                            </Menu.Dropdown>
                          </Menu>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <SsoProviderModal
        opened={editing !== null}
        onClose={() => onEdit(null)}
        provider={editing}
      />
    </>
  );
}
