import { Anchor, Avatar, Badge, Group, Skeleton, Table, Text, Tooltip } from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { buildPageUrl } from "@/features/page/page.utils";
import { IVerificationListItem } from "@/features/page-verification/types";
import { statusColor, statusLabel } from "./status";

interface Props {
  items?: IVerificationListItem[];
  isLoading: boolean;
}

const MAX_AVATARS = 3;

function dueText(item: IVerificationListItem, t: (k: string) => string): string {
  if (item.type === "qms") return item.status === "approved" ? t("Until replaced") : "—";
  if (item.status === "invalidated") return "—";
  if (!item.expiresAt) return t("Indefinitely");
  const date = new Date(item.expiresAt);
  return date.getTime() <= Date.now() ? t("Expired") : date.toLocaleDateString();
}

export default function VerificationTable({ items, isLoading }: Props) {
  const { t } = useTranslation();
  const rows = items ?? [];

  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Page")}</Table.Th>
            <Table.Th>{t("Verifiers")}</Table.Th>
            <Table.Th>{t("Verified until")}</Table.Th>
            <Table.Th>{t("Status")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading && rows.length === 0 &&
            Array.from({ length: 5 }).map((_, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <Skeleton height={12} width={200} mb={6} />
                  <Skeleton height={10} width={120} />
                </Table.Td>
                <Table.Td>
                  <Skeleton circle height={24} />
                </Table.Td>
                <Table.Td>
                  <Skeleton height={12} width={90} />
                </Table.Td>
                <Table.Td>
                  <Skeleton height={18} width={80} />
                </Table.Td>
              </Table.Tr>
            ))}
          {!isLoading && rows.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text c="dimmed" ta="center" py="xl">
                  {t("No verified pages yet. Open a page and choose Add verification.")}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {rows.map((item) => {
            const verifiers = item.verifiers ?? [];
            return (
              <Table.Tr key={item.id}>
                <Table.Td>
                  <Anchor
                    component={Link}
                    to={buildPageUrl(item.spaceSlug, item.pageSlugId, item.pageTitle ?? undefined)}
                    underline="never"
                    c="var(--mantine-color-text)"
                  >
                    <Text size="sm" fw={500} lineClamp={1}>
                      {item.pageIcon ? `${item.pageIcon} ` : ""}
                      {item.pageTitle || t("Untitled")}
                    </Text>
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {item.spaceName}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {verifiers.length === 1 ? (
                    <Group gap="xs" wrap="nowrap">
                      <CustomAvatar avatarUrl={verifiers[0].avatarUrl ?? undefined} name={verifiers[0].name} size={24} />
                      <Text size="sm" lineClamp={1}>
                        {verifiers[0].name}
                      </Text>
                    </Group>
                  ) : (
                    <Tooltip label={verifiers.map((v) => v.name).join(", ")} disabled={verifiers.length === 0}>
                      <Avatar.Group spacing="xs">
                        {verifiers.slice(0, MAX_AVATARS).map((v) => (
                          <CustomAvatar key={v.id} avatarUrl={v.avatarUrl ?? undefined} name={v.name} size={24} />
                        ))}
                        {verifiers.length > MAX_AVATARS && (
                          <Avatar size={24} radius="xl">
                            +{verifiers.length - MAX_AVATARS}
                          </Avatar>
                        )}
                      </Avatar.Group>
                    </Tooltip>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{dueText(item, t)}</Text>
                </Table.Td>
                <Table.Td>
                  {item.status !== "none" && (
                    <Badge color={statusColor(item.status)} variant="light" size="sm" tt="none">
                      {statusLabel(item.status, t)}
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
