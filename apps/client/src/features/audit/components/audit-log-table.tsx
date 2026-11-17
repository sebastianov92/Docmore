import { Fragment, useState } from "react";
import {
  Anchor,
  Badge,
  Box,
  Code,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconArrowRight, IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { buildPageUrl } from "@/features/page/page.utils";
import { IAuditLog } from "@/features/audit/types/audit.types";
import { eventLabel, resourceTypeLabel } from "@/features/audit/lib/audit-events";
import { formatDateTime, timeAgo } from "@/features/audit/lib/audit-time";
import classes from "./audit-log-table.module.css";

interface Props {
  items?: IAuditLog[];
  isLoading: boolean;
}

export default function AuditLogTable({ items, isLoading }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);

  const rows = items ?? [];

  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={28} />
            <Table.Th>{t("Who")}</Table.Th>
            <Table.Th>{t("Event")}</Table.Th>
            <Table.Th>{t("Resource")}</Table.Th>
            <Table.Th>{t("When")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading && rows.length === 0 && <LoadingRows />}
          {!isLoading && rows.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={5}>
                <Text c="dimmed" ta="center" py="xl">
                  {t("No audit events match these filters.")}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
          {rows.map((entry) => {
            const expandable = hasDetails(entry);
            const expanded = open === entry.id;
            return (
              <Fragment key={entry.id}>
                <Table.Tr
                  className={expandable ? classes.clickable : undefined}
                  onClick={() => expandable && setOpen(expanded ? null : entry.id)}
                  aria-expanded={expandable ? expanded : undefined}
                >
                  <Table.Td>
                    {expandable && (
                      <UnstyledButton
                        aria-label={expanded ? t("Hide details") : t("Show details")}
                        className={classes.chevron}
                      >
                        {expanded ? (
                          <IconChevronDown size={16} />
                        ) : (
                          <IconChevronRight size={16} />
                        )}
                      </UnstyledButton>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <ActorCell entry={entry} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={500}>
                        {t(eventLabel(entry.event))}
                      </Text>
                      <Badge size="xs" variant="light" color="gray" tt="none">
                        {t(resourceTypeLabel(entry.resourceType))}
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <ResourceCell entry={entry} />
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatDateTime(entry.createdAt)} openDelay={300}>
                      <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        {timeAgo(entry.createdAt)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
                {expanded && (
                  <Table.Tr className={classes.detailsRow}>
                    <Table.Td />
                    <Table.Td colSpan={4}>
                      <Details entry={entry} />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function hasDetails(entry: IAuditLog): boolean {
  return Boolean(
    entry.changes?.before ||
      entry.changes?.after ||
      (entry.metadata && Object.keys(entry.metadata).length > 0) ||
      entry.ipAddress ||
      entry.userAgent,
  );
}

function ActorCell({ entry }: { entry: IAuditLog }) {
  const { t } = useTranslation();
  if (!entry.actor) {
    const label =
      entry.actorType === "api_key"
        ? t("API key")
        : entry.actorType === "system"
          ? t("System")
          : t("Unknown user");
    return (
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    );
  }
  return (
    <Group gap="sm" wrap="nowrap">
      <CustomAvatar
        avatarUrl={entry.actor.avatarUrl ?? undefined}
        name={entry.actor.name}
        size="sm"
      />
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={500} lineClamp={1}>
          {entry.actor.name}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {entry.actor.email}
        </Text>
      </div>
    </Group>
  );
}

function resourceLink(entry: IAuditLog): string | null {
  const r = entry.resource;
  if (!r) return null;
  switch (entry.resourceType) {
    case "page":
      return r.spaceSlug && r.slugId ? buildPageUrl(r.spaceSlug, r.slugId, r.name) : null;
    case "space":
    case "space_member":
      return r.slug ? `/s/${r.slug}` : null;
    case "group":
      return `/settings/groups/${r.id}`;
    case "user":
      return "/settings/members";
    case "sso_provider":
      return "/settings/security";
    case "api_key":
      return "/settings/api-management";
    default:
      return null;
  }
}

function ResourceCell({ entry }: { entry: IAuditLog }) {
  const name = entry.resource?.name;
  if (!name) {
    return (
      <Text size="sm" c="dimmed">
        {entry.resourceId ? entry.resourceId.slice(0, 8) : "—"}
      </Text>
    );
  }
  const href = resourceLink(entry);
  if (!href) {
    return (
      <Text size="sm" lineClamp={1}>
        {name}
      </Text>
    );
  }
  return (
    <Anchor
      component={Link}
      to={href}
      size="sm"
      underline="hover"
      c="var(--mantine-color-text)"
      onClick={(e) => e.stopPropagation()}
    >
      <Text size="sm" lineClamp={1} component="span">
        {name}
      </Text>
    </Anchor>
  );
}

function Details({ entry }: { entry: IAuditLog }) {
  const { t } = useTranslation();
  const before = entry.changes?.before ?? {};
  const after = entry.changes?.after ?? {};
  const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const metadata = Object.entries(entry.metadata ?? {});

  return (
    <Stack gap="sm" py={4}>
      {changedKeys.length > 0 && (
        <Box>
          <Text size="xs" fw={600} mb={4}>
            {t("Changes")}
          </Text>
          {changedKeys.map((key) => (
            <Group key={key} gap={6} wrap="nowrap" mb={2}>
              <Text size="xs" c="dimmed" fw={500}>
                {key}
              </Text>
              {key in before && <Code fz="xs">{show(before[key])}</Code>}
              {key in before && key in after && <IconArrowRight size={12} />}
              {key in after && <Code fz="xs">{show(after[key])}</Code>}
            </Group>
          ))}
        </Box>
      )}
      {metadata.length > 0 && (
        <Box>
          <Text size="xs" fw={600} mb={4}>
            {t("Details")}
          </Text>
          {metadata.map(([key, value]) => (
            <Group key={key} gap={6} wrap="nowrap" mb={2}>
              <Text size="xs" c="dimmed" fw={500}>
                {key}
              </Text>
              <Text size="xs" style={{ wordBreak: "break-word" }}>
                {show(value)}
              </Text>
            </Group>
          ))}
        </Box>
      )}
      {(entry.ipAddress || entry.userAgent) && (
        <Text size="xs" c="dimmed">
          {[entry.ipAddress, entry.userAgent].filter(Boolean).join(" · ")}
        </Text>
      )}
    </Stack>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <Table.Tr key={i}>
          <Table.Td />
          <Table.Td>
            <Group gap="sm" wrap="nowrap">
              <Skeleton circle height={26} />
              <div>
                <Skeleton height={12} width={110} mb={6} />
                <Skeleton height={10} width={150} />
              </div>
            </Group>
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={140} />
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={120} />
          </Table.Td>
          <Table.Td>
            <Skeleton height={12} width={80} />
          </Table.Td>
        </Table.Tr>
      ))}
    </>
  );
}
