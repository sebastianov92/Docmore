import { Menu } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCloudDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { isOnline } from "@/lib/offline/connectivity.ts";
import { syncNow, useOfflineStatus } from "@/lib/offline/engine.ts";
import { isPagePinned, isPinned, setPinned, usePinsVersion } from "@/lib/offline/pins.ts";

type Props = {
  type: "page" | "space";
  id: string;
};

// "Available offline" for a page (with everything under it) or a whole space.
export function OfflinePinMenuItem({ type, id }: Props) {
  const { t } = useTranslation();
  usePinsVersion();
  const { ready } = useOfflineStatus();

  if (!ready || !id) return null;

  const pinned = isPinned(type, id);
  // held because a parent page or the space is
  const inherited = type === "page" && !pinned && isPagePinned(id);

  const toggle = async () => {
    await setPinned(type, id, !pinned);
    if (!pinned) {
      notifications.show({
        message: isOnline()
          ? t("Downloading for offline use")
          : t("It will download when the server is reachable"),
      });
    } else {
      notifications.show({ message: t("No longer kept on this device") });
    }
    void syncNow();
  };

  return (
    <Menu.Item
      leftSection={<IconCloudDown size={16} />}
      rightSection={pinned || inherited ? <IconCheck size={14} /> : null}
      disabled={inherited}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      }}
    >
      {inherited ? t("Available offline with its parent") : t("Available offline")}
    </Menu.Item>
  );
}
