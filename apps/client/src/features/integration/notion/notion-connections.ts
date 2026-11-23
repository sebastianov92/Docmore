import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";

// A connection to Notion the workspace keeps: the secret went in once and
// is not handed back; imports use it by its id.
export type NotionConnection = {
  id: string;
  name: string;
  // the Notion workspace it belongs to
  account: string | null;
  addedBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export const NOTION_CONNECTIONS_KEY = ["notion-connections"];

export async function listNotionConnections(): Promise<{ items: NotionConnection[]; canManage: boolean }> {
  return (await api.post("/import/notion/connections")).data;
}

export async function createNotionConnection(data: { token: string; name?: string }): Promise<NotionConnection> {
  return (await api.post("/import/notion/connections/create", data)).data;
}

export async function deleteNotionConnection(connectionId: string): Promise<void> {
  await api.post("/import/notion/connections/delete", { connectionId });
}

export function useNotionConnections(enabled = true) {
  return useQuery({ queryKey: NOTION_CONNECTIONS_KEY, queryFn: listNotionConnections, enabled });
}

// What Notion answered, in the reader's language when it is one of the usual cases.
export function notionError(message: string, t: (key: string) => string): string {
  if (message.includes("did not accept the token")) return t("Notion did not accept the secret. Copy it again from your connection.");
  if (message.includes("not allowed to read")) return t("The connection is not allowed to read that. Give it “Read content” in Notion.");
  if (message.includes("shared with the connection")) return t("Notion did not find it: the page has to be shared with the connection.");
  if (message.includes("limiting requests")) return t("Notion is limiting requests right now. Try again in a few minutes.");
  if (message.includes("still running")) return t("An import of yours is still running.");
  if (message.includes("does not look like the link")) return t("That does not look like the link of a Notion page.");
  if (message.includes("in the trash")) return t("That page is in the trash in Notion.");
  if (message.includes("Paste the secret")) return t("Paste the secret of your Notion connection.");
  if (message.includes("keeps at most")) return t("This workspace already keeps as many Notion connections as it can. Remove one first.");
  return message;
}
