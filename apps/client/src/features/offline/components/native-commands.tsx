import { useEffect } from "react";
import { useAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { desktopSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";
import { searchSpotlight } from "@/features/search/constants.ts";
import { MEETING_RECORDER_EVENT } from "@/features/ai/meetings/services";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { useUnreadCountQuery } from "@/features/notification/queries/notification-query.ts";
import { extractPageSlugId } from "@/lib";
import { isNativeApp, nativeCall, nativeCan, nativeSend, onNativeEvent } from "@/lib/native/bridge.ts";
import { getSpace, getSpaces } from "@/lib/offline/recorder.ts";
import { treeGet } from "@/lib/offline/tree-store.ts";
import { getConnectivity, setWorkOffline } from "@/lib/offline/connectivity.ts";
import { syncNow, wipeOfflineData } from "@/lib/offline/engine.ts";
import { OFFLINE_SETTINGS_PATH } from "./offline-indicator.tsx";

export const NEW_PAGE_COMMAND_EVENT = "docmore:new-page";

// Record Meeting from the app menu: on the open page, or as a new page of
// the space being looked at.
async function recordMeetingHere(): Promise<void> {
  const match = window.location.pathname.match(/^\/s\/([^/]+)(?:\/p\/([^/]+))?/);
  const pageSlug = match?.[2] ? extractPageSlugId(match[2]) : undefined;
  const page = pageSlug ? await treeGet(pageSlug) : undefined;
  if (!nativeCan("meetings")) {
    if (page) window.dispatchEvent(new CustomEvent(MEETING_RECORDER_EVENT, { detail: { pageId: page.id } }));
    return;
  }
  const space = match?.[1] ? await getSpace(match[1]) : (await getSpaces())[0];
  try {
    await nativeCall("meeting.start", page ? { pageId: page.id } : { spaceId: space?.id });
  } catch (error: any) {
    notifications.show({ color: "red", message: error?.message ?? "Recording could not start" });
  }
}

// The desktop shell's menus and deep links, turned into what the web app
// already knows how to do. Renders nothing.
export function NativeCommands() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [socket] = useAtom(socketAtom);
  const { data: unread } = useUnreadCountQuery();
  const [desktopSidebarOpened] = useAtom(desktopSidebarAtom);
  const toggleSidebar = useToggleSidebar(desktopSidebarAtom);

  useEffect(() => {
    if (!isNativeApp()) return;
    const offNavigate = onNativeEvent<{ path?: string }>("navigate", (payload) => {
      if (payload?.path?.startsWith("/")) navigate(payload.path);
    });
    const offCommand = onNativeEvent<{ id?: string }>("command", (payload) => {
      switch (payload?.id) {
        case "search":
          searchSpotlight.open();
          break;
        case "toggle-sidebar":
          toggleSidebar();
          break;
        case "work-offline":
          setWorkOffline(!getConnectivity().workOffline);
          break;
        case "sync-now":
          void syncNow();
          break;
        case "offline-settings":
          navigate(OFFLINE_SETTINGS_PATH);
          break;
        case "settings":
          navigate("/settings/account/profile");
          break;
        case "home":
          navigate("/home");
          break;
        case "new-page":
          window.dispatchEvent(new CustomEvent(NEW_PAGE_COMMAND_EVENT));
          break;
        case "record-meeting":
          void recordMeetingHere();
          break;
        case "clear-offline-data":
          void wipeOfflineData().then(() => window.location.reload());
          break;
        default:
          break;
      }
    });
    const offMeetingDone = onNativeEvent<{ pageId?: string }>("meeting.done", () => {
      void queryClient.invalidateQueries({ queryKey: ["pages"] });
    });
    return () => {
      offNavigate();
      offCommand();
      offMeetingDone();
    };
  }, [navigate, toggleSidebar, desktopSidebarOpened, queryClient]);

  // Dock badge and system notifications
  useEffect(() => {
    if (isNativeApp()) nativeSend("badge", { count: unread?.count ?? 0 });
  }, [unread?.count]);

  useEffect(() => {
    if (!socket || !isNativeApp()) return;
    const onNotification = () => {
      nativeSend("notify", {
        title: "Docmore",
        body: t("You have a new notification"),
        path: "/home",
      });
    };
    socket.on("notification", onNotification);
    return () => {
      socket.off("notification", onNotification);
    };
  }, [socket, t]);

  return null;
}
