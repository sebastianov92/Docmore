import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route";
import { validateMfaAccess } from "@/features/mfa/services/mfa-service.ts";

// The MFA pages only make sense while the cookie holds a half-finished login.
// Sends the visitor to login, to the right MFA page, or into the app otherwise.
export function useMfaGate() {
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    validateMfaAccess().then((access) => {
      if (cancelled) return;
      const search = location.search;

      if (!access.valid) {
        navigate(APP_ROUTE.AUTH.LOGIN + search, { replace: true });
        return;
      }
      if (!access.isTransferToken) {
        navigate(getPostLoginRedirect(), { replace: true });
        return;
      }

      const wanted = access.requiresMfaSetup
        ? APP_ROUTE.AUTH.MFA_SETUP_REQUIRED
        : APP_ROUTE.AUTH.MFA_CHALLENGE;
      if (location.pathname !== wanted) {
        navigate(wanted + search, { replace: true });
        return;
      }

      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [navigate, location.pathname, location.search]);

  return { ready };
}
