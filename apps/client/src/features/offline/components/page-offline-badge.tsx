import { Tooltip } from "@mantine/core";
import { IconCircleArrowDownFilled, IconCloudDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useConnectivity } from "@/lib/offline/connectivity.ts";
import { isPagePinned, usePageOfflineState } from "@/lib/offline/pins.ts";

// Small mark in the tree for pages the person chose to keep on this device.
export function PageOfflineBadge({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const state = usePageOfflineState(pageId);

  if (state === "none" || !isPagePinned(pageId)) return null;

  const downloaded = state === "downloaded";
  return (
    <Tooltip label={downloaded ? t("On this device") : t("Waiting to download")} openDelay={400} withArrow>
      <span
        aria-label={downloaded ? t("On this device") : t("Waiting to download")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          marginLeft: 4,
          color: downloaded ? "var(--mantine-color-teal-6)" : "var(--mantine-color-dimmed)",
        }}
      >
        {downloaded ? <IconCircleArrowDownFilled size={13} /> : <IconCloudDown size={13} />}
      </span>
    </Tooltip>
  );
}

// With no server, a page that is not on the device cannot be opened: the
// tree shows it faded, like a file that only lives in the cloud.
export function usePageUnavailableOffline(pageId: string): boolean {
  const { online } = useConnectivity();
  const state = usePageOfflineState(pageId);
  return !online && state !== "downloaded";
}
