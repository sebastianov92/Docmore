import { useEffect, useMemo, useState } from "react";
import { Alert, Anchor, Box, Button, Center, Checkbox, Container, Divider, Group, Loader, Paper, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconEye, IconPencil, IconDeviceDesktop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { RESET } from "jotai/utils";
import { useTranslation } from "react-i18next";
import { useLocation, useSearchParams } from "react-router-dom";
import { AuthLayout } from "@/features/auth/components/auth-layout.tsx";
import classes from "@/features/auth/components/auth.module.css";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { UserInfo } from "@/components/common/user-info.tsx";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { logout } from "@/features/auth/services/auth-service";
import { ICurrentUser } from "@/features/user/types/user.types";
import APP_ROUTE from "@/lib/app-route.ts";
import { deleteLocalPageData } from "@/lib/local-page-data.ts";
import { decideAuthorization, getAuthorizeInfo } from "../services";
import { OAuthAuthorizeInfo, OAuthAuthorizeParams } from "../types";

function loginUrl(pathname: string, search: string) {
  return `${APP_ROUTE.AUTH.LOGIN}?redirect=${encodeURIComponent(pathname + search)}`;
}

function status(error: any): number | undefined {
  return error?.response?.status;
}

// A 401 without an OAuth error body means the session is gone; the OAuth
// server also answers 401 for client problems, which must not send the user
// to the login page (the login page would bounce them straight back here).
function sessionExpired(error: any): boolean {
  return status(error) === 401 && typeof error?.response?.data?.error_description !== "string";
}

function describe(error: any): string | undefined {
  const data = error?.response?.data;
  if (typeof data?.error_description === "string") return data.error_description;
  if (Array.isArray(data?.message)) return data.message.join(", ");
  return data?.message;
}

// /oauth/consent: an MCP client sent the user here to ask for access. The
// request is checked server-side first, then the user approves or denies
// and is sent back to the client's redirect URI.
export default function OAuthConsentPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const params = useMemo<OAuthAuthorizeParams>(() => Object.fromEntries(searchParams.entries()), [searchParams]);
  const currentUser = useCurrentUser();
  const [, setCurrentUser] = useAtom(currentUserAtom);
  const info = useQuery({ queryKey: ["oauth-authorize-info", params], queryFn: () => getAuthorizeInfo(params), retry: false });

  useEffect(() => {
    if (currentUser.data?.user) setCurrentUser(currentUser.data);
  }, [currentUser.data, setCurrentUser]);

  const unauthenticated = sessionExpired(currentUser.error) || sessionExpired(info.error);
  useEffect(() => {
    if (unauthenticated) window.location.replace(loginUrl(location.pathname, location.search));
  }, [unauthenticated, location.pathname, location.search]);

  const loading = unauthenticated || currentUser.isLoading || info.isLoading;

  return (
    <AuthLayout>
      <DocumentTitle title={t("Authorize application")} />
      <Container size={460} className={classes.container}>
        <Box p="xl">
          {loading ? (
            <Center mih={200}>
              <Loader />
            </Center>
          ) : info.data && currentUser.data ? (
            <ConsentCard info={info.data} currentUser={currentUser.data} params={params} />
          ) : (
            <Stack align="center" gap="sm">
              <ThemeIcon size={48} radius="xl" variant="light" color="red">
                <IconAlertTriangle size={26} stroke={1.5} />
              </ThemeIcon>
              <Title order={3} ta="center" fw={600}>
                {t("This authorization request is not valid")}
              </Title>
              {describe(info.error ?? currentUser.error) && (
                <Text size="sm" c="dimmed" ta="center">
                  {describe(info.error ?? currentUser.error)}
                </Text>
              )}
            </Stack>
          )}
        </Box>
      </Container>
    </AuthLayout>
  );
}

function ConsentCard({ info, currentUser, params }: { info: OAuthAuthorizeInfo; currentUser: ICurrentUser; params: OAuthAuthorizeParams }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [, setCurrentUser] = useAtom(currentUserAtom);
  // Docmore's own desktop app asks for the whole account, nothing to pick.
  const isAppRequest = info.scopes.includes("app");
  const [approved, setApproved] = useState<string[]>(
    isAppRequest ? ["app"] : info.scopes.filter((s) => s === "read" || s === "write"),
  );
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  const rows = isAppRequest
    ? [
        {
          scope: "app",
          icon: <IconDeviceDesktop size={16} stroke={1.5} />,
          label: t("Full access to your account"),
          description: t(
            "The app signs in as you and can do everything you can do here. Only allow this for the Docmore app on your own device.",
          ),
        },
      ]
    : [
        { scope: "read", icon: <IconEye size={16} stroke={1.5} />, label: t("Read"), description: t("Search and read the pages you can see.") },
        { scope: "write", icon: <IconPencil size={16} stroke={1.5} />, label: t("Write"), description: t("Create and change pages as you.") },
      ];

  const decide = async (yes: boolean) => {
    setBusy(yes ? "approve" : "deny");
    try {
      const res = await decideAuthorization(params, yes ? { approved: true, approvedScopes: approved } : { approved: false });
      window.location.replace(res.redirectUrl);
    } catch (err) {
      if (sessionExpired(err)) {
        window.location.replace(loginUrl(location.pathname, location.search));
        return;
      }
      setBusy(null);
      notifications.show({ message: describe(err) || t("Something went wrong. Please try again."), color: "red" });
    }
  };

  const switchAccount = async () => {
    if (busy) return;
    setCurrentUser(RESET);
    try {
      await deleteLocalPageData();
      await logout();
    } finally {
      window.location.replace(loginUrl(location.pathname, location.search));
    }
  };

  return (
    <Stack gap="lg">
      <Title order={3} ta="center" fw={600}>
        {t("{{name}} wants to access {{workspace}}", { name: info.clientName, workspace: currentUser.workspace.name })}
      </Title>

      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" wrap="nowrap">
          <UserInfo user={currentUser.user} />
          <Anchor component="button" type="button" size="xs" c="dimmed" disabled={busy !== null} onClick={switchAccount} style={{ whiteSpace: "nowrap" }}>
            {t("Not you? Switch account")}
          </Anchor>
        </Group>
      </Paper>

      <Divider />

      <Stack gap="sm">
        <Text size="sm" fw={500}>
          {t("It will be able to:")}
        </Text>
        {rows.map((row) => {
          const requested = info.scopes.includes(row.scope);
          return (
            <Checkbox
              key={row.scope}
              size="sm"
              checked={approved.includes(row.scope)}
              disabled={!requested || isAppRequest || busy !== null}
              onChange={(e) =>
                setApproved((prev) => (e.currentTarget.checked ? [...prev, row.scope] : prev.filter((s) => s !== row.scope)))
              }
              label={
                <Group gap={6} wrap="nowrap">
                  {row.icon}
                  <Text size="sm" fw={500}>
                    {row.label}
                  </Text>
                </Group>
              }
              description={row.description}
            />
          );
        })}
      </Stack>

      <div>
        <Text size="xs" c="dimmed">
          {t("You will be sent back to")}
        </Text>
        <Text size="xs" ff="monospace" style={{ overflowWrap: "anywhere" }}>
          {info.redirectUri}
        </Text>
      </div>

      {!info.verified && (
        <Alert variant="light" color="yellow" py="xs" icon={<IconAlertTriangle size={16} />}>
          {t("This app registered itself. Only continue if you started this from a tool you trust.")}
        </Alert>
      )}

      <Group grow>
        <Button variant="default" onClick={() => decide(false)} loading={busy === "deny"} disabled={busy === "approve"}>
          {t("Cancel")}
        </Button>
        <Button onClick={() => decide(true)} loading={busy === "approve"} disabled={approved.length === 0 || busy === "deny"}>
          {t("Authorize")}
        </Button>
      </Group>
    </Stack>
  );
}
