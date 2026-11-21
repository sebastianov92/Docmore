import { useAtom, useSetAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import React, { useEffect } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useTranslation } from "react-i18next";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { io } from "socket.io-client";
import { SOCKET_URL } from "@/features/websocket/types";
import { useQuerySubscription } from "@/features/websocket/use-query-subscription.ts";
import { useTreeSocket } from "@/features/websocket/use-tree-socket.ts";
import { useNotificationSocket } from "@/features/notification/hooks/use-notification-socket.ts";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { useEntitlements } from "@/ee/entitlement/use-entitlements";
import { entitlementAtom } from "@/ee/entitlement/entitlement-atom";
import { nativeInfo } from "@/lib/native/bridge.ts";
import { startOfflineEngine } from "@/lib/offline/engine.ts";
import { isOfflineError } from "@/lib/offline/connectivity.ts";
import { queryClient } from "@/main.tsx";
import { OfflineNoData } from "@/features/offline/components/offline-no-data.tsx";

export function UserProvider({ children }: React.PropsWithChildren) {
  const [, setCurrentUser] = useAtom(currentUserAtom);
  const setEntitlements = useSetAtom(entitlementAtom);
  const { data, isLoading, error, isError } = useCurrentUser();
  const { data: entitlements } = useEntitlements();
  const { i18n } = useTranslation();
  const [, setSocket] = useAtom(socketAtom);
  // fetch collab token on load
  const { data: collab } = useCollabToken();
  const collabToken = nativeInfo() ? collab?.token : undefined;

  useEffect(() => {
    if (isLoading || isError) {
      return;
    }

    // In the desktop app the page is not on the server's origin, so the
    // session cookie never travels: the socket goes straight to the server
    // and signs in with the collab token.
    const native = nativeInfo();
    if (native && !collabToken) return;
    const newSocket = native
      ? io(native.serverUrl, {
          transports: ["websocket"],
          auth: { token: collabToken },
        })
      : io(SOCKET_URL, {
          transports: ["websocket"],
          withCredentials: true,
        });

    // @ts-ignore
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("ws connected");
    });

    return () => {
      console.log("ws disconnected");
      newSocket.disconnect();
    };
  }, [isError, isLoading, collabToken]);

  useQuerySubscription();
  useTreeSocket();
  useNotificationSocket();

  useEffect(() => {
    if (data && data.user && data.workspace) {
      setCurrentUser(data);
      void startOfflineEngine(queryClient, data as any);
      i18n.changeLanguage(
        data.user.locale === "en" ? "en-US" : data.user.locale,
      );
    }
  }, [data, isLoading]);

  useEffect(() => {
    if (entitlements) {
      setEntitlements(entitlements);
    }
  }, [entitlements]);

  if (isLoading) return <></>;

  if (isError && error?.["response"]?.status === 404) {
    return <Error404 />;
  }

  // no server and nothing of this account on the device yet
  if (isOfflineError(error)) {
    return <OfflineNoData />;
  }

  if (error) {
    return <></>;
  }

  return <>{children}</>;
}
