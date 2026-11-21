import { Button, Group, Loader, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconCloudOff, IconCloudUp, IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { probeServer, setWorkOffline, useConnectivity } from "@/lib/offline/connectivity.ts";
import { syncNow, useOfflineStatus } from "@/lib/offline/engine.ts";
import classes from "./offline-indicator.module.css";

export const OFFLINE_SETTINGS_PATH = "/settings/account/offline";

// Header pill. It is there only when there is something to say: no server,
// changes waiting to be sent, a download running, or changes the server
// refused.
export function OfflineIndicator() {
  const { t } = useTranslation();
  const { online, workOffline } = useConnectivity();
  const status = useOfflineStatus();

  const downloading = status.download !== null;
  const hasConflicts = status.conflicts > 0;
  if (online && status.pending === 0 && !downloading && !hasConflicts) return null;

  let label: string;
  let icon = <IconCloudOff size={15} stroke={1.8} />;
  let tone = classes.offline;
  if (!online) {
    label = status.pending > 0 ? t("Offline · {{count}} to send", { count: status.pending }) : t("Offline");
  } else if (hasConflicts) {
    label = t("{{count}} to review", { count: status.conflicts });
    icon = <IconAlertTriangle size={15} stroke={1.8} />;
    tone = classes.review;
  } else if (downloading) {
    label = t("Downloading {{done}}/{{total}}", {
      done: status.download!.done,
      total: status.download!.total,
    });
    icon = <Loader size={12} color="currentColor" />;
    tone = classes.busy;
  } else {
    label = t("Sending {{count}}", { count: status.pending });
    icon = status.syncing ? <Loader size={12} color="currentColor" /> : <IconCloudUp size={15} stroke={1.8} />;
    tone = classes.busy;
  }

  return (
    <Popover width={320} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton
          className={`${classes.pill} ${tone}`}
          role="status"
          aria-label={label}
          data-testid="offline-indicator"
        >
          <Group gap={6} wrap="nowrap">
            {icon}
            <Text size="xs" fw={600} visibleFrom="sm">
              {label}
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          {!online && (
            <Text size="sm">
              {workOffline
                ? t(
                    "You are working offline. Changes stay on this device and are sent when you go back online.",
                  )
                : t(
                    "The server cannot be reached. Changes stay on this device and are sent when it is back.",
                  )}
            </Text>
          )}
          {status.pending > 0 && (
            <Text size="sm" c="dimmed">
              {t("{{count}} changes waiting to be sent", { count: status.pending })}
            </Text>
          )}
          {hasConflicts && (
            <Text size="sm" c="dimmed">
              {t("{{count}} changes could not be applied and need your decision", {
                count: status.conflicts,
              })}
            </Text>
          )}
          <Group gap="xs">
            {!online && workOffline && (
              <Button size="xs" onClick={() => setWorkOffline(false)}>
                {t("Go back online")}
              </Button>
            )}
            {!online && !workOffline && (
              <Button size="xs" variant="default" onClick={() => probeServer()}>
                {t("Retry now")}
              </Button>
            )}
            {online && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                loading={status.syncing}
                onClick={() => void syncNow()}
              >
                {t("Sync now")}
              </Button>
            )}
            <Button size="xs" variant="subtle" component={Link} to={OFFLINE_SETTINGS_PATH}>
              {hasConflicts ? t("Review") : t("Offline settings")}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
