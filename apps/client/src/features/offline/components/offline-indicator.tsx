import { Button, Group, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconCloudOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  probeServer,
  setWorkOffline,
  useConnectivity,
} from "@/lib/offline/connectivity.ts";
import classes from "./offline-indicator.module.css";

// Header pill that only shows while the server is out of reach or the person
// chose to work offline.
export function OfflineIndicator() {
  const { t } = useTranslation();
  const { online, workOffline } = useConnectivity();

  if (online) return null;

  return (
    <Popover width={300} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton
          className={classes.pill}
          role="status"
          aria-label={t("Offline")}
          data-testid="offline-indicator"
        >
          <Group gap={6} wrap="nowrap">
            <IconCloudOff size={15} stroke={1.8} />
            <Text size="xs" fw={600} visibleFrom="sm">
              {t("Offline")}
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="sm">
            {workOffline
              ? t(
                  "You are working offline. Changes stay on this device and are sent when you go back online.",
                )
              : t(
                  "The server cannot be reached. Changes stay on this device and are sent when it is back.",
                )}
          </Text>
          {workOffline ? (
            <Button size="xs" onClick={() => setWorkOffline(false)}>
              {t("Go back online")}
            </Button>
          ) : (
            <Button size="xs" variant="default" onClick={() => probeServer()}>
              {t("Retry now")}
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
