import { allPageInfos, getSpaces, recordedFor } from "./recorder.ts";
import { treeAll } from "./tree-store.ts";

// Search with no server: titles of every page in the tree, and the text of
// the pages that are on this device.

const MAX_RESULTS = 25;

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function contentText(content: unknown): string {
  const parts: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) {
      node.content.forEach(visit);
      parts.push("\n");
    }
  };
  visit(content);
  return parts.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 100);
  return (
    (start > 0 ? "…" : "") +
    escapeHtml(text.slice(start, index)) +
    "<b>" +
    escapeHtml(text.slice(index, index + length)) +
    "</b>" +
    escapeHtml(text.slice(index + length, end)) +
    (end < text.length ? "…" : "")
  );
}

export async function searchPagesOffline(body: any): Promise<{ items: any[] }> {
  const query = fold(String(body?.query ?? "").trim());
  if (!query) return { items: [] };
  const spaces = new Map((await getSpaces()).map((space) => [space.id, space]));
  const rows = await treeAll();
  const infos = new Map((await allPageInfos()).map((info) => [info.id, info]));
  const results: Array<{ score: number; item: any }> = [];

  for (const row of rows) {
    if (body?.spaceId && row.spaceId !== body.spaceId) continue;
    if (body?.creatorId && row.creatorId !== body.creatorId) continue;
    const title = row.title ?? "";
    const titleIndex = fold(title).indexOf(query);
    let highlight = "";
    let score = 0;
    if (titleIndex >= 0) score = titleIndex === 0 ? 3 : 2;
    if (!body?.titleOnly) {
      const info = infos.get(row.id);
      const text = info ? contentText(info.content) : "";
      const textIndex = text ? fold(text).indexOf(query) : -1;
      if (textIndex >= 0) {
        highlight = snippet(text, textIndex, query.length);
        score += 1;
      }
    }
    if (score === 0) continue;
    const space = spaces.get(row.spaceId);
    results.push({
      score,
      item: {
        id: row.id,
        slugId: row.slugId,
        title,
        icon: row.icon,
        parentPageId: row.parentPageId,
        creatorId: row.creatorId,
        createdAt: row.updatedAt,
        updatedAt: row.updatedAt,
        rank: String(score),
        highlight,
        matchedText: [],
        wholeWord: false,
        space: space ? { id: space.id, name: space.name, slug: space.slug } : { id: row.spaceId },
      },
    });
  }

  results.sort((a, b) => b.score - a.score || (a.item.updatedAt < b.item.updatedAt ? 1 : -1));
  return { items: results.slice(0, MAX_RESULTS).map((result) => result.item) };
}

// Mentions and link pickers.
export async function searchSuggestionsOffline(body: any): Promise<Record<string, unknown[]>> {
  const query = fold(String(body?.query ?? "").trim());
  const limit = Math.min(Number(body?.limit) || 10, 25);
  const out: Record<string, unknown[]> = {};
  if (body?.includePages !== false) {
    const spaces = new Map((await getSpaces()).map((space) => [space.id, space]));
    out.pages = (await treeAll())
      .filter((row) => (!body?.spaceId || row.spaceId === body.spaceId) && fold(row.title ?? "").includes(query))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        slugId: row.slugId,
        title: row.title,
        icon: row.icon,
        spaceId: row.spaceId,
        space: spaces.get(row.spaceId)
          ? { id: row.spaceId, name: spaces.get(row.spaceId)!.name, slug: spaces.get(row.spaceId)!.slug }
          : { id: row.spaceId },
      }));
  }
  if (body?.includeUsers) {
    const seen = new Map<string, any>();
    for (const record of await recordedFor("/workspace/members")) {
      for (const user of (record.data as any)?.items ?? []) {
        if (user?.id && !seen.has(user.id)) seen.set(user.id, user);
      }
    }
    out.users = [...seen.values()]
      .filter((user) => fold(`${user.name ?? ""} ${user.email ?? ""}`).includes(query))
      .slice(0, limit);
  }
  if (body?.includeGroups) out.groups = [];
  return out;
}
