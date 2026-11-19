import axios, { AxiosInstance } from "axios";
import APP_ROUTE from "@/lib/app-route.ts";
import { isCloud } from "@/lib/config.ts";
import { currentShareId, getShareAccessToken } from "@/features/share/share-access";

const api: AxiosInstance = axios.create({
  baseURL: "/api",
  withCredentials: true,
});

// Pages opened through a password-protected share link send the token the
// unlock step stored, so the page, its tree and embedded bases all load.
api.interceptors.request.use((config) => {
  const shareId = currentShareId();
  if (shareId) {
    const token = getShareAccessToken(shareId);
    if (token) {
      config.headers.set("x-share-token", token);
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    // we need the response headers for these endpoints
    const exemptEndpoints = [
      "/api/pages/export",
      "/api/spaces/export",
      "/api/docx-export",
      "/api/pdf-export/download",
      "/api/bases/export-csv",
      "/api/audit/export",
    ];
    if (response.request.responseURL) {
      const path = new URL(response.request.responseURL)?.pathname;
      if (path && exemptEndpoints.includes(path)) {
        return response;
      }
    }

    return response.data;
  },
  async (error) => {
    const data = error.response?.data;
    if (data instanceof Blob && data.type.includes("json")) {
      try {
        error.response.data = JSON.parse(await data.text());
      } catch {
        // not json, keep the blob
      }
    }

    if (error.response) {
      switch (error.response.status) {
        case 401: {
          const url = new URL(error.request.responseURL)?.pathname;
          if (url === "/api/auth/collab-token") return;
          // shared pages read the reason (a password prompt) off the rejection
          if (window.location.pathname.startsWith("/share/")) break;
          // public docs probe authed endpoints; reject without the login redirect
          if (
            window.location.pathname === "/docs" ||
            window.location.pathname.startsWith("/docs/")
          ) {
            break;
          }
          // the banner poll runs in the background; an idle reader stays on the page
          if (url === "/api/announcements/visible") break;

          // Handle unauthorized error
          redirectToLogin();
          break;
        }
        case 403:
          // Handle forbidden error
          break;
        case 404:
          // Handle not found error
          if (
            error.response.data.message
              .toLowerCase()
              .includes("workspace not found")
          ) {
            console.log("workspace not found");
            if (
              !isCloud() &&
              window.location.pathname != APP_ROUTE.AUTH.SETUP
            ) {
              window.location.href = APP_ROUTE.AUTH.SETUP;
            }
          }
          break;
        case 500:
          // Handle internal server error
          break;
        default:
          break;
      }
    }
    return Promise.reject(error);
  },
);

function redirectToLogin() {
  const exemptPaths = [
    APP_ROUTE.AUTH.LOGIN,
    APP_ROUTE.AUTH.SIGNUP,
    APP_ROUTE.AUTH.FORGOT_PASSWORD,
    APP_ROUTE.AUTH.PASSWORD_RESET,
    APP_ROUTE.AUTH.MFA_CHALLENGE,
    APP_ROUTE.AUTH.MFA_SETUP_REQUIRED,
    "/invites",
    // the oauth consent page redirects to login itself, preserving its query string
    "/oauth/consent",
  ];
  const { pathname, search, hash } = window.location;
  if (!exemptPaths.some((path) => pathname.startsWith(path))) {
    if (pathname === APP_ROUTE.HOME) {
      window.location.href = APP_ROUTE.AUTH.LOGIN;
    } else {
      const params = new URLSearchParams({ redirect: pathname + search + hash });
      window.location.href = `${APP_ROUTE.AUTH.LOGIN}?${params.toString()}`;
    }
  }
}

export default api;
