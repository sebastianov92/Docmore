import { useCallback, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useInterval } from "@mantine/hooks";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { MAIN_CONTENT_ID } from "@/components/ui/skip-to-main.tsx";
import { announcementBannersHeightAtom } from "../atoms";
import { useVisibleAnnouncementsQuery } from "../queries";
import { ANNOUNCEMENT_BANNERS_HEIGHT_VAR, AnnouncementSurface } from "../types";
import { dismissAnnouncement, getAnnouncementFingerprint, isAnnouncementDismissed, isAnnouncementVisibleAt } from "../utils";
import { AnnouncementBanner } from "./announcement-banner";
import classes from "./announcement-banners.module.css";

interface Props {
  surface: AnnouncementSurface;
  onHeightChange?: (height: number) => void;
}

// One banner at a time, the newest that is live now; it comes and goes on
// the server's clock without a refetch, and a dismissed one stays hidden
// until its text or look changes. Publishes its height for the layout.
export default function AnnouncementBanners({ surface, onHeightChange }: Props) {
  const { t } = useTranslation();
  const { data } = useVisibleAnnouncementsQuery(surface);
  const items = data?.items ?? [];
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const setBannersHeight = useSetAtom(announcementBannersHeightAtom);
  const [overflowing, setOverflowing] = useState(false);
  const publishedRef = useRef<number | null>(null);

  useInterval(rerender, 30_000, { autoInvoke: true });

  const now = Date.now() + (data?.offsetMs ?? 0);
  const banners = items
    .filter((a) => isAnnouncementVisibleAt(a, now))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .slice(0, 1)
    .filter((a) => !(a.isDismissible && isAnnouncementDismissed(a)));
  const hasBanners = banners.length > 0;
  const bannersKey = banners.map((a) => `${a.id}:${getAnnouncementFingerprint(a)}`).join(",");

  const publishHeight = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    setOverflowing(root.scrollHeight > root.clientHeight);
    const height = root.getBoundingClientRect().height;
    if (height === publishedRef.current) return;
    publishedRef.current = height;
    document.documentElement.style.setProperty(ANNOUNCEMENT_BANNERS_HEIGHT_VAR, `${height}px`);
    setBannersHeight(height);
    onHeightChange?.(height);
  }, [onHeightChange, setBannersHeight]);

  useLayoutEffect(() => {
    publishHeight();
  }, [bannersKey, publishHeight]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(publishHeight);
    observer.observe(root);
    return () => {
      observer.disconnect();
      publishedRef.current = null;
      document.documentElement.style.removeProperty(ANNOUNCEMENT_BANNERS_HEIGHT_VAR);
      setBannersHeight(0);
      onHeightChange?.(0);
    };
  }, [publishHeight, onHeightChange, setBannersHeight]);

  return (
    <div
      ref={rootRef}
      className={classes.root}
      data-has-banners={hasBanners || undefined}
      tabIndex={overflowing ? 0 : undefined}
      role={hasBanners ? "region" : undefined}
      aria-label={hasBanners ? t("Announcements") : undefined}
    >
      {banners.map((announcement) => (
        <AnnouncementBanner
          key={announcement.id}
          announcement={announcement}
          onDismiss={(event) => {
            const buttons = Array.from(rootRef.current?.querySelectorAll("button") ?? []);
            const next = buttons[buttons.indexOf(event.currentTarget) + 1] ?? document.getElementById(MAIN_CONTENT_ID);
            dismissAnnouncement(announcement);
            (next as HTMLElement | null)?.focus({ preventScroll: true });
            rerender();
          }}
        />
      ))}
    </div>
  );
}
