import bytes from "bytes";
import { castToBoolean } from "@/lib/utils.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { sanitizeUrl } from "@docmost/editor-ext";
import { nativeInfo } from "@/lib/native/bridge.ts";

declare global {
  interface Window {
    CONFIG?: Record<string, string>;
  }
}

export function getAppName(): string {
  return "Docmore";
}

// Where the app is reachable for other people: links to share, callback
// URLs. In the desktop app the page lives on docmore-app://, so this is the
// server, not the window.
export function getAppUrl(): string {
  return nativeInfo()?.serverUrl ?? getWindowOrigin();
}

// Where this page was loaded from. API calls and files go here: in the
// desktop app that is the shell, which adds the sign-in and keeps files for
// offline use.
export function getWindowOrigin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

// True for the host of this app's own links (pasted page links, internal
// links): the window, and in the desktop app also the server behind it.
export function isOwnHost(host: string | undefined | null): boolean {
  if (!host) return false;
  if (host === window.location.host) return true;
  const serverUrl = nativeInfo()?.serverUrl;
  if (!serverUrl) return false;
  try {
    return new URL(serverUrl).host === host;
  } catch {
    return false;
  }
}

export function getServerAppUrl(): string {
  return getConfigValue("APP_URL");
}

export function getBackendUrl(): string {
  return getWindowOrigin() + "/api";
}

export function getCollaborationUrl(): string {
  // sockets cannot go through the desktop shell, they talk to the server
  const baseUrl =
    getConfigValue("COLLAB_URL") ||
    nativeInfo()?.serverUrl ||
    (import.meta.env.DEV ? process.env.APP_URL : getAppUrl());

  const collabUrl = new URL("/collab", baseUrl);
  collabUrl.protocol = collabUrl.protocol === "https:" ? "wss:" : "ws:";
  return collabUrl.toString();
}

export function getSubdomainHost(): string {
  return getConfigValue("SUBDOMAIN_HOST");
}

export function isCloud(): boolean {
  return castToBoolean(getConfigValue("CLOUD"));
}

export function isBetaPublicSpaces(): boolean {
  return castToBoolean(getConfigValue("BETA_PUBLIC_SPACES"));
}

export function isUnsplashEnabled(): boolean {
  return castToBoolean(getConfigValue("UNSPLASH_ENABLED"));
}

export function getAiVectorDriver(): string {
  return getConfigValue("AI_VECTOR_DRIVER");
}

export function getAvatarUrl(
  avatarUrl: string,
  type: AvatarIconType = AvatarIconType.AVATAR,
) {
  if (!avatarUrl) return null;
  if (avatarUrl?.startsWith("http")) return avatarUrl;

  return getBackendUrl() + `/attachments/img/${type}/` + encodeURI(avatarUrl);
}

export function getSpaceUrl(spaceSlug: string) {
  return "/s/" + spaceSlug;
}

export function getFileUrl(src: string) {
  if (!src) return src;
  if (src.startsWith("http")) return src;
  if (src.startsWith("/api/")) {
    // Remove the '/api' prefix
    return getBackendUrl() + src.substring(4);
  }
  if (src.startsWith("/files/")) {
    return getBackendUrl() + src;
  }
  return sanitizeUrl(src);
}

export function getFileUploadSizeLimit() {
  const limit = getConfigValue("FILE_UPLOAD_SIZE_LIMIT", "50mb");
  return bytes(limit);
}

export function getFileImportSizeLimit() {
  const limit = getConfigValue("FILE_IMPORT_SIZE_LIMIT", "200mb");
  return bytes(limit);
}

export function getDrawioUrl() {
  return getConfigValue("DRAWIO_URL", "https://embed.diagrams.net");
}

export function getBillingTrialDays() {
  return getConfigValue("BILLING_TRIAL_DAYS");
}

export function getPostHogHost() {
  return getConfigValue("POSTHOG_HOST");
}

export function isPostHogEnabled(): boolean {
  return Boolean(getPostHogHost() && getPostHogKey());
}

export function getPostHogKey() {
  return getConfigValue("POSTHOG_KEY");
}

function getConfigValue(key: string, defaultValue: string = undefined): string {
  const rawValue = import.meta.env.DEV
    ? process?.env?.[key]
    : window?.CONFIG?.[key];
  return rawValue ?? defaultValue;
}
