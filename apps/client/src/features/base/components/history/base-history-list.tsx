import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Group, Loader, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRestore } from "@tabler/icons-react";
import { listBaseHistory, restoreBaseVersion } from "@/features/base/services/base-service";
import { IRowVersion } from "@/features/base/types/base.types";
import { useTimeAgo } from "@/hooks/use-time-ago";

type Props = {
  pageId: string;
  // only this row's versions
  rowId?: string;
  canEdit: boolean;
  compact?: boolean;
};

export const historyQueryKey = (pageId: string, rowId?: string) => ["base-history", pageId, rowId ?? null];

// Cell snapshots of a base (or one row), newest first, each with a way back.
export function BaseHistoryList({ pageId, rowId, canEdit, compact }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const limit = compact ? 20 : 50;
  const query = useInfiniteQuery({
    queryKey: historyQueryKey(pageId, rowId),
    queryFn: ({ pageParam }) => listBaseHistory({ pageId, rowId, before: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta.hasNextPage ? last.meta.nextBefore ?? undefined : undefined),
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const restore = useMutation({
    mutationFn: (versionId: string) => restoreBaseVersion({ pageId, versionId }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["base-rows", pageId] });
      queryClient.invalidateQueries({ queryKey: ["base-history", pageId] });
      notifications.show({ message: result.restoredDeleted ? t("Row brought back") : t("Row restored") });
    },
    onError: () => notifications.show({ message: t("Could not restore"), color: "red" }),
  });

  if (query.isLoading) return <Loader size="xs" />;
  if (items.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t("No changes recorded yet")}
      </Text>
    );
  }
  return (
    <Stack gap={6} data-testid="base-history-list">
      {items.map((v) => (
        <HistoryItem key={v.id} version={v} canEdit={canEdit} showTitle={!rowId} onRestore={() => restore.mutate(v.id)} restoring={restore.isPending && restore.variables === v.id} />
      ))}
      {query.hasNextPage && (
        <Button size="compact-xs" variant="subtle" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
          {t("Load more")}
        </Button>
      )}
    </Stack>
  );
}

const KIND_COLOR: Record<string, string> = { update: "blue", delete: "red", convert: "orange", restore: "teal" };

function HistoryItem({ version, canEdit, showTitle, onRestore, restoring }: { version: IRowVersion; canEdit: boolean; showTitle: boolean; onRestore: () => void; restoring: boolean }) {
  const { t } = useTranslation();
  const ago = useTimeAgo(version.createdAt as unknown as Date);
  const kindLabel: Record<string, string> = {
    update: t("Edited"),
    delete: t("Deleted"),
    convert: t("Before conversion"),
    restore: t("Before restore"),
  };
  return (
    <Group gap="xs" wrap="nowrap" justify="space-between" data-testid="history-item">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <Badge size="xs" variant="light" color={KIND_COLOR[version.kind] ?? "gray"} style={{ textTransform: "none", flexShrink: 0 }}>
          {kindLabel[version.kind] ?? version.kind}
        </Badge>
        <Text size="xs" truncate style={{ minWidth: 0 }}>
          {showTitle ? version.title || t("Untitled") : ""}
          {showTitle ? " · " : ""}
          <Text span size="xs" c="dimmed">
            {version.actorName ?? t("Someone")} · {ago}
            {version.rowDeleted ? ` · ${t("row deleted")}` : ""}
          </Text>
        </Text>
      </Group>
      {canEdit && (
        <Tooltip label={version.rowDeleted ? t("Bring the row back with these values") : t("Put these values back")}>
          <Button size="compact-xs" variant="subtle" leftSection={<IconRestore size={12} />} onClick={onRestore} loading={restoring}>
            {t("Restore")}
          </Button>
        </Tooltip>
      )}
    </Group>
  );
}
