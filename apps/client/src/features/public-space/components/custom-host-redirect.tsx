import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "@/lib/api-client";
import { getAppUrl } from "@/lib/config.ts";

// On a hostname other than the app's own, the root shows the public space
// mapped to it (Settings of the space -> Custom domain).
export function CustomHostRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.pathname !== "/") return;
    let appHost = "";
    try {
      appHost = new URL(getAppUrl()).hostname;
    } catch {
      return;
    }
    const here = window.location.hostname;
    if (!appHost || here === appHost || here === "localhost") return;
    api
      .post<{ spaceSlug: string }>("/public-space/by-host", { host: here })
      .then((res) => {
        const slug = (res.data as any)?.spaceSlug ?? (res.data as any)?.data?.spaceSlug;
        if (slug) navigate(`/docs/${slug}`, { replace: true });
      })
      .catch(() => undefined);
  }, [location.pathname, navigate]);
  return null;
}
