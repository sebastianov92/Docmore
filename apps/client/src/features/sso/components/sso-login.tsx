import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Alert, Button, Divider, Stack } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import { getRedirectParam } from "@/lib/app-route.ts";
import { OpenIdIcon } from "@/components/icons/openid-icon.tsx";
import { IPublicAuthProvider } from "@/features/sso/types/sso.types.ts";
import {
  buildSsoLoginUrl,
  readSsoError,
  SSO_ERROR_PARAM,
} from "@/features/sso/sso.utils.ts";

const AUTO_ATTEMPT_KEY = "docmore:ssoAutoAttempt";
const AUTO_ATTEMPT_TTL_MS = 5 * 60_000;

function recentAutoAttempt(): boolean {
  try {
    const raw = window.sessionStorage.getItem(AUTO_ATTEMPT_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < AUTO_ATTEMPT_TTL_MS;
  } catch {
    return false;
  }
}

function markAutoAttempt(): void {
  try {
    window.sessionStorage.setItem(AUTO_ATTEMPT_KEY, String(Date.now()));
  } catch {
    // Private mode or storage disabled: just skip the circuit breaker.
  }
}

// Single sign-on buttons for the login and invitation pages. With SSO
// enforced and a single provider the browser goes straight to it.
export default function SsoLogin() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { data } = useWorkspacePublicDataQuery();
  const { data: currentUser } = useCurrentUser();
  const autoRedirected = useRef(false);

  const providers: IPublicAuthProvider[] = data?.authProviders ?? [];
  const ssoError = readSsoError(location.search);

  const goToProvider = (provider: IPublicAuthProvider) => {
    window.location.href = buildSsoLoginUrl({
      type: provider.type,
      providerId: provider.id,
      redirect: getRedirectParam(),
    });
  };

  useEffect(() => {
    if (autoRedirected.current) return;
    if (!data?.enforceSso || providers.length !== 1) return;
    // Already signed in: let the page's own redirect take over.
    if (currentUser?.user) return;
    const params = new URLSearchParams(location.search);
    // After a logout or a failed attempt the person needs to see the page.
    if (params.has("logout") || params.has(SSO_ERROR_PARAM)) return;
    if (recentAutoAttempt()) return;

    autoRedirected.current = true;
    markAutoAttempt();
    goToProvider(providers[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, currentUser, location.search]);

  const dismissError = () => {
    const params = new URLSearchParams(location.search);
    params.delete(SSO_ERROR_PARAM);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "" },
      { replace: true },
    );
  };

  if (providers.length === 0 && !ssoError) {
    return null;
  }

  return (
    <>
      {ssoError && (
        <Alert
          variant="light"
          color="red"
          icon={<IconAlertCircle size={18} />}
          title={t("Single sign-on failed")}
          withCloseButton
          onClose={dismissError}
          closeButtonLabel={t("Dismiss")}
          mb="md"
        >
          {ssoError}
        </Alert>
      )}

      {providers.length > 0 && (
        <>
          <Stack align="stretch" justify="center" gap="sm">
            {providers.map((provider) => (
              <Button
                key={provider.id}
                onClick={() => goToProvider(provider)}
                leftSection={<OpenIdIcon size={16} />}
                variant="default"
                fullWidth
              >
                {t("Continue with {{name}}", { name: provider.name })}
              </Button>
            ))}
          </Stack>

          {!data?.enforceSso && (
            <Divider my="md" label={t("OR")} labelPosition="center" />
          )}
        </>
      )}
    </>
  );
}
