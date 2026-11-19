import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Button, Drawer, Group, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconHistory } from "@tabler/icons-react";
import { IBase } from "@/features/base/types/base.types";
import { restoreDeletedRows } from "@/features/base/services/base-service";
import { BaseHistoryList } from "./base-history-list";

// Toolbar entry: a drawer with the base's cell history and a quick undo
// for rows deleted in the last minutes or hours.
export function BaseHistoryButton({ base, canEdit }: { base: IBase; canEdit: boolean }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const queryClient = useQueryClient();
  const restoreDeleted = useMutation({
    mutationFn: (minutes: number) =>
      restoreDeletedRows({ pageId: base.id, since: new Date(Date.now() - minutes * 60_000).toISOString() }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["base-rows", base.id] });
      queryClient.invalidateQueries({ queryKey: ["base-history", base.id] });
      notifications.show({ message: t("{{count}} rows brought back", { count: r.count }) });
    },
    onError: () => notifications.show({ message: t("Could not restore"), color: "red" }),
  });
  return (
    <>
      <Tooltip label={t("History")}>
        <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => setOpened(true)} aria-label={t("History")} data-testid="base-history-button">
          <IconHistory size={16} />
        </ActionIcon>
      </Tooltip>
      <Drawer opened={opened} onClose={() => setOpened(false)} position="right" size="md" title={t("History")}>
        {canEdit && (
          <Group gap="xs" mb="sm" wrap="wrap">
            <Text size="xs" c="dimmed">
              {t("Bring back rows deleted in the last")}
            </Text>
            {[
              { minutes: 10, label: t("10 min") },
              { minutes: 60, label: t("hour") },
              { minutes: 1440, label: t("24 hours") },
            ].map((o) => (
              <Button key={o.minutes} size="compact-xs" variant="light" onClick={() => restoreDeleted.mutate(o.minutes)} loading={restoreDeleted.isPending && restoreDeleted.variables === o.minutes}>
                {o.label}
              </Button>
            ))}
          </Group>
        )}
        {opened && <BaseHistoryList pageId={base.id} canEdit={canEdit} />}
      </Drawer>
    </>
  );
}
