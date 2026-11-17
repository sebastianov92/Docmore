import {
  ANNOUNCEMENT_PREVIEW_LENGTH,
  AnnouncementBanner,
  AnnouncementContent,
} from "./types";

const SAFE_PROTOCOLS = ["https:", "http:", "mailto:"];
// Browsers drop tabs and newlines, so "/\t/host" would act as "//host".
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cs}]/u;
const DISMISSED_PREFIX = "docmore.announcement.dismissed.";
const sessionDismissals = new Map<string, string>();

export function isSafeAnnouncementHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  const value = href.trim();
  if (!value || UNSAFE_CHARACTERS.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//") && !value.startsWith("/\\");
  try {
    return SAFE_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function isAnnouncementVisibleAt(a: Pick<AnnouncementBanner, "startsAt" | "endsAt">, nowMs: number): boolean {
  return Date.parse(a.startsAt) <= nowMs && (!a.endsAt || nowMs < Date.parse(a.endsAt));
}

export function getAnnouncementPlainText(content: AnnouncementContent | null | undefined): string {
  if (!content) return "";
  return content.content
    .flatMap((paragraph) => paragraph.content ?? [])
    .map((node) => node.text)
    .join("");
}

export function getAnnouncementPreview(content: AnnouncementContent): string {
  const text = getAnnouncementPlainText(content).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length <= ANNOUNCEMENT_PREVIEW_LENGTH
    ? text
    : `${chars.slice(0, ANNOUNCEMENT_PREVIEW_LENGTH - 1).join("")}…`;
}

// A dismissed banner comes back when its text or look changes.
export function getAnnouncementFingerprint(a: Pick<AnnouncementBanner, "type" | "color" | "content">): string {
  const text = JSON.stringify([a.type, a.color, a.content]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}

export function isAnnouncementDismissed(a: Pick<AnnouncementBanner, "id" | "type" | "color" | "content">): boolean {
  const fingerprint = getAnnouncementFingerprint(a);
  if (sessionDismissals.get(a.id) === fingerprint) return true;
  try {
    return localStorage.getItem(DISMISSED_PREFIX + a.id) === fingerprint;
  } catch {
    return false;
  }
}

export function dismissAnnouncement(a: Pick<AnnouncementBanner, "id" | "type" | "color" | "content">): void {
  const fingerprint = getAnnouncementFingerprint(a);
  sessionDismissals.set(a.id, fingerprint);
  try {
    localStorage.setItem(DISMISSED_PREFIX + a.id, fingerprint);
  } catch {
    /* blocked storage: hidden until reload */
  }
}

export function formatAnnouncementTime(time: string | number | Date, language?: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
}
