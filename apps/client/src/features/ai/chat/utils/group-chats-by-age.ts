import { AiChat } from "../types";

export interface ChatGroup {
  key: string;
  label: string;
  chats: AiChat[];
}

const DAY = 24 * 60 * 60 * 1000;

// Today, yesterday, the last week, the last month, older: by last activity.
export function groupChatsByAge(chats: AiChat[], t: (key: string) => string): ChatGroup[] {
  if (chats.length === 0) return [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: ChatGroup[] = [
    { key: "today", label: t("Today"), chats: [] },
    { key: "yesterday", label: t("Yesterday"), chats: [] },
    { key: "week", label: t("Previous 7 days"), chats: [] },
    { key: "month", label: t("Previous 30 days"), chats: [] },
    { key: "older", label: t("Older"), chats: [] },
  ];
  for (const chat of chats) {
    const at = new Date(chat.updatedAt).getTime();
    const index = at >= today ? 0 : at >= today - DAY ? 1 : at >= today - 7 * DAY ? 2 : at >= today - 30 * DAY ? 3 : 4;
    buckets[index].chats.push(chat);
  }
  return buckets.filter((b) => b.chats.length > 0);
}

export function formatChatTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= today) {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}
