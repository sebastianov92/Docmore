import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import { markLocalPageDoc } from "./docs.ts";
import { looksLikeUuid, newSlugId, uuidv7 } from "./ids.ts";
import {
  PageInfo,
  forgetRecorded,
  getMe,
  getPageInfo,
  getSpace,
  patchPageInfo,
  patchRecorded,
  recordResponse,
  recordedFor,
  replay,
  savePageInfo,
} from "./recorder.ts";
import { searchPagesOffline, searchSuggestionsOffline } from "./search.ts";
import {
  TreeRow,
  treeAncestors,
  treeChildCounts,
  treeChildren,
  treeGet,
  treeHasSpace,
  treeLastPosition,
  treePatch,
  treeRemove,
  treeSubtree,
  treeUpsert,
} from "./tree-store.ts";

// What the device can answer or do with no server, route by route.
//
// A reader answers a read from local data and returns undefined when it
// cannot (the caller then tries the last recorded answer).
//
// A mutation keeps the local data in step with a write. Online it is told
// what the server answered; offline it does the write locally, returns what
// the server would have answered, and the request is queued.

export type MutationResult = {
  data: unknown;
  // the body to queue when it differs from the request (ids minted here)
  body?: any;
};

export type OfflineMutation = {
  // false: this exact request needs the server
  canQueue?: (body: any) => boolean;
  apply: (ctx: { body: any; server?: any }) => Promise<MutationResult>;
  describe: (body: any, result?: MutationResult) => { kind: string; title?: string; pageId?: string };
};

const EMPTY_META = { hasNextPage: false, hasPrevPage: false, nextCursor: null, prevCursor: null };

function brief(user: Record<string, any> | undefined) {
  if (!user) return null;
  return { id: user.id, name: user.name, avatarUrl: user.avatarUrl ?? null };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function rowFromPage(page: Record<string, any>, extra: Partial<TreeRow> = {}): TreeRow {
  return {
    id: page.id,
    slugId: page.slugId,
    title: page.title ?? null,
    icon: page.icon ?? null,
    position: page.position,
    parentPageId: page.parentPageId ?? null,
    spaceId: page.spaceId,
    creatorId: page.creatorId ?? null,
    isBase: Boolean(page.isBase),
    updatedAt: typeof page.updatedAt === "string" ? page.updatedAt : nowIso(),
    canEdit: page.canEdit ?? page.permissions?.canEdit ?? true,
    ...extra,
  };
}

async function sidebarItem(row: TreeRow, parents: Set<string>) {
  return {
    id: row.id,
    slugId: row.slugId,
    title: row.title,
    icon: row.icon,
    position: row.position,
    parentPageId: row.parentPageId,
    spaceId: row.spaceId,
    creatorId: row.creatorId,
    isBase: row.isBase,
    updatedAt: row.updatedAt,
    deletedAt: null,
    hasChildren: parents.has(row.id),
    canEdit: row.canEdit,
  };
}

// ---- readers ---------------------------------------------------------------

export const READERS: Record<string, (body: any) => Promise<unknown | undefined>> = {
  "/pages/sidebar-pages": async (body) => {
    let spaceId: string | undefined = body?.spaceId;
    let parentPageId: string | null = null;
    if (body?.pageId) {
      const parent = await treeGet(body.pageId);
      if (!parent) return undefined;
      spaceId = parent.spaceId;
      parentPageId = parent.id;
    }
    if (!spaceId || !(await treeHasSpace(spaceId))) return undefined;
    // the whole level goes out in the first page
    if (body?.cursor) return { items: [], meta: { ...EMPTY_META, limit: body?.limit ?? 100 } };
    const parents = await treeChildCounts();
    const rows = await treeChildren(spaceId, parentPageId);
    return {
      items: await Promise.all(rows.map((row) => sidebarItem(row, parents))),
      meta: { ...EMPTY_META, limit: body?.limit ?? 100 },
    };
  },

  "/pages/info": async (body) => {
    if (!body?.pageId) return undefined;
    const info = await getPageInfo(body.pageId);
    if (!info) return undefined;
    // the tree is fresher for what it holds
    const row = await treeGet(info.id);
    if (!row) return info;
    return {
      ...info,
      title: row.title,
      icon: row.icon,
      parentPageId: row.parentPageId,
      position: row.position,
      spaceId: row.spaceId,
      permissions: { ...(info.permissions ?? { hasRestriction: false }), canEdit: row.canEdit },
    };
  },

  // Rows of a base as last listed. A view whose exact filter and sort were
  // never asked for online gets every row the device knows, in base order:
  // filters and sorts are the server's work.
  "/bases/rows": async (body) => {
    if (!body?.pageId) return undefined;
    const exact = await replay("/bases/rows", body);
    if (exact.found) return exact.data;
    if (body.templates) return undefined;
    const meta = { ...EMPTY_META, limit: body.limit ?? 100 };
    const byId = new Map<string, any>();
    let known = false;
    for (const record of await recordedFor("/bases/rows")) {
      const recordBody = record.body as any;
      if (recordBody?.pageId !== body.pageId || recordBody?.templates) continue;
      known = true;
      for (const row of (record.data as any)?.items ?? []) {
        if (row?.id) byId.set(row.id, row);
      }
    }
    if (!known) return undefined;
    if (body.cursor) return { items: [], meta };
    const items = [...byId.values()].sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
    );
    return { items, meta };
  },

  // A space the device knows in full (the engine fetches each one), asked by
  // id or by slug: a page that was downloaded opens even if its space was
  // never looked at on this device.
  "/spaces/info": async (body) => {
    if (!body?.spaceId) return undefined;
    const space = await getSpace(body.spaceId);
    return space?.membership ? space : undefined;
  },

  "/search": (body) => searchPagesOffline(body),

  "/search/suggest": (body) => searchSuggestionsOffline(body),

  "/pages/breadcrumbs": async (body) => {
    if (!body?.pageId) return undefined;
    const row = await treeGet(body.pageId);
    if (!row || !(await treeHasSpace(row.spaceId))) return undefined;
    const parents = await treeChildCounts();
    return (await treeAncestors(row.id)).map((ancestor) => ({
      id: ancestor.id,
      slugId: ancestor.slugId,
      title: ancestor.title,
      icon: ancestor.icon,
      isBase: ancestor.isBase,
      position: ancestor.position,
      parentPageId: ancestor.parentPageId,
      spaceId: ancestor.spaceId,
      deletedAt: null,
      hasChildren: parents.has(ancestor.id),
    }));
  },
};

// ---- mutations -------------------------------------------------------------

async function resolvePage(idOrSlug: string): Promise<{ row?: TreeRow; info?: PageInfo }> {
  const row = await treeGet(idOrSlug);
  const info = await getPageInfo(row?.id ?? idOrSlug);
  return { row, info };
}

const PAGE_PATCH_KEYS = ["title", "icon", "coverPhoto", "coverPosition", "coverAttribution", "ownerId"];

const pageCreate: OfflineMutation = {
  // content goes through the server's converters
  canQueue: (body) => Boolean(body?.spaceId) && body?.content === undefined,
  apply: async ({ body, server }) => {
    if (server) {
      if (server.id && server.spaceId) await treeUpsert(rowFromPage(server));
      return { data: server };
    }
    const me = await getMe();
    const user = me?.user;
    const id = looksLikeUuid(body.id) ? body.id : uuidv7();
    const slugId = typeof body.slugId === "string" ? body.slugId : newSlugId();
    const parentPageId: string | null = body.parentPageId ?? null;
    const now = nowIso();
    const position = generateJitteredKeyBetween(await treeLastPosition(body.spaceId, parentPageId), null);
    const page = {
      id,
      slugId,
      title: body.title ?? null,
      icon: body.icon ?? null,
      coverPhoto: null,
      coverPosition: null,
      coverAttribution: null,
      position,
      parentPageId,
      creatorId: user?.id ?? null,
      ownerId: user?.id ?? null,
      lastUpdatedById: user?.id ?? null,
      spaceId: body.spaceId,
      workspaceId: me?.workspace?.id ?? null,
      isLocked: false,
      isBase: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      contributorIds: [],
      permissions: { canEdit: true, hasRestriction: false },
    };
    await treeUpsert(rowFromPage(page, { localOnly: true }));
    const space = await getSpace(body.spaceId);
    await savePageInfo({
      ...page,
      content: null,
      creator: brief(user),
      lastUpdatedBy: brief(user),
      owner: brief(user),
      contributors: [],
      deletedBy: null,
      space: space ? { id: space.id, name: space.name, slug: space.slug } : { id: body.spaceId },
    });
    // its empty local copy is the real page: the editor may open it right away
    await markLocalPageDoc(id);
    return { data: page, body: { ...body, id, slugId } };
  },
  describe: (body, result) => ({
    kind: "page.create",
    title: body?.title ?? undefined,
    pageId: (result?.data as any)?.id ?? body?.id,
  }),
};

const pageUpdate: OfflineMutation = {
  canQueue: (body) => Boolean(body?.pageId) && body?.content === undefined,
  apply: async ({ body, server }) => {
    const { row, info } = await resolvePage(body.pageId);
    const source = server ?? body;
    const patch: Record<string, unknown> = {};
    for (const key of PAGE_PATCH_KEYS) {
      if (key in source) patch[key] = source[key];
    }
    patch.updatedAt = server?.updatedAt ?? nowIso();
    if (row) {
      await treePatch(row.id, {
        ...("title" in patch ? { title: (patch.title as string) ?? null } : {}),
        ...("icon" in patch ? { icon: (patch.icon as string) ?? null } : {}),
        updatedAt: patch.updatedAt as string,
      });
    }
    const next = info ? await patchPageInfo(info.id, patch) : undefined;
    return { data: server ?? next ?? { ...(row ?? {}), ...patch } };
  },
  describe: (body) => ({
    kind: "title" in (body ?? {}) ? "page.rename" : "page.update",
    title: body?.title ?? undefined,
    pageId: body?.pageId,
  }),
};

const pageMove: OfflineMutation = {
  canQueue: (body) => Boolean(body?.pageId),
  apply: async ({ body, server }) => {
    const { row, info } = await resolvePage(body.pageId);
    const patch: Record<string, unknown> = {};
    if ("parentPageId" in body) patch.parentPageId = body.parentPageId ?? null;
    if (typeof body.position === "string") patch.position = body.position;
    if (row) await treePatch(row.id, patch as Partial<TreeRow>);
    if (info) await patchPageInfo(info.id, patch);
    return { data: server };
  },
  describe: (body) => ({ kind: "page.move", pageId: body?.pageId }),
};

const pageDelete: OfflineMutation = {
  // a permanent delete cannot be undone, it waits for the server
  canQueue: (body) => Boolean(body?.pageId) && !body?.permanentlyDelete,
  apply: async ({ body, server }) => {
    const row = await treeGet(body.pageId);
    if (row) await treeRemove((await treeSubtree(row.id)).map((r) => r.id));
    return { data: server };
  },
  describe: (body) => ({ kind: "page.trash", pageId: body?.pageId }),
};

// ---- comments ----------------------------------------------------------------

const COMMENT_LIST_LIMIT = 100;

async function patchComment(
  commentId: string,
  mutate: (comment: any) => any | null,
): Promise<any | undefined> {
  let result: any;
  for (const record of await recordedFor("/comments")) {
    const data: any = record.data;
    if (!Array.isArray(data?.items)) continue;
    const index = data.items.findIndex((item: any) => item?.id === commentId);
    if (index < 0) continue;
    const next = mutate(data.items[index]);
    if (next === null) data.items.splice(index, 1);
    else data.items[index] = result = next;
    await recordResponse("/comments", record.body, data);
  }
  return result;
}

const commentCreate: OfflineMutation = {
  // a comment by someone who cannot edit is anchored by the server
  canQueue: (body) => Boolean(body?.pageId) && !body?.yjsSelection,
  apply: async ({ body, server }) => {
    let comment = server;
    let queued = body;
    if (!comment) {
      const me = await getMe();
      const row = await treeGet(body.pageId);
      const now = nowIso();
      const id = looksLikeUuid(body.id) ? body.id : uuidv7();
      let content: unknown = body.content;
      try {
        if (typeof content === "string") content = JSON.parse(content);
      } catch {
        // kept as sent
      }
      comment = {
        id,
        content,
        selection: body.selection ?? null,
        type: body.type ?? "page",
        creatorId: me?.user?.id ?? null,
        pageId: body.pageId,
        parentCommentId: body.parentCommentId ?? null,
        workspaceId: me?.workspace?.id ?? null,
        resolvedAt: null,
        createdAt: now,
        editedAt: null,
        deletedAt: null,
        lastEditedById: null,
        resolvedById: null,
        updatedAt: now,
        spaceId: row?.spaceId ?? null,
        baseRowId: body.baseRowId ?? null,
        creator: brief(me?.user),
        resolvedBy: null,
      };
      queued = { ...body, id };
    }
    if (!comment.baseRowId) {
      const patched = await patchRecorded(
        "/comments",
        (b) => b?.pageId === comment.pageId && !b?.cursor && !b?.baseRowId,
        (data) => {
          if (!Array.isArray(data?.items)) return;
          if (!data.items.some((item: any) => item?.id === comment.id)) data.items.push(comment);
        },
      );
      if (patched === 0 && !server) {
        await recordResponse(
          "/comments",
          { pageId: comment.pageId, limit: COMMENT_LIST_LIMIT },
          { items: [comment], meta: { ...EMPTY_META, limit: COMMENT_LIST_LIMIT } },
        );
      }
    }
    return { data: comment, body: queued };
  },
  describe: (body) => ({ kind: "comment.create", pageId: body?.pageId }),
};

const commentResolve: OfflineMutation = {
  canQueue: (body) => Boolean(body?.commentId),
  apply: async ({ body, server }) => {
    const me = await getMe();
    const patched = await patchComment(body.commentId, (comment) => ({
      ...comment,
      ...(server ?? {
        resolvedAt: body.resolved ? nowIso() : null,
        resolvedById: body.resolved ? (me?.user?.id ?? null) : null,
        resolvedBy: body.resolved ? brief(me?.user) : null,
      }),
    }));
    return { data: server ?? patched ?? { id: body.commentId } };
  },
  describe: (body) => ({ kind: "comment.resolve", pageId: body?.pageId }),
};

const commentUpdate: OfflineMutation = {
  canQueue: (body) => Boolean(body?.commentId),
  apply: async ({ body, server }) => {
    let content: unknown = body.content;
    try {
      if (typeof content === "string") content = JSON.parse(content);
    } catch {
      // kept as sent
    }
    const patched = await patchComment(body.commentId, (comment) => ({
      ...comment,
      ...(server ?? { content, editedAt: nowIso() }),
    }));
    return { data: server ?? patched ?? { id: body.commentId } };
  },
  describe: () => ({ kind: "comment.update" }),
};

const commentDelete: OfflineMutation = {
  canQueue: (body) => Boolean(body?.commentId),
  apply: async ({ body, server }) => {
    await patchComment(body.commentId, () => null);
    return { data: server };
  },
  describe: () => ({ kind: "comment.delete" }),
};

// ---- favorites ---------------------------------------------------------------

function favoriteKey(body: any): { type: string; id: string } | null {
  if (body?.pageId) return { type: "page", id: body.pageId };
  if (body?.spaceId) return { type: "space", id: body.spaceId };
  if (body?.templateId) return { type: "template", id: body.templateId };
  return null;
}

const favoriteToggle = (add: boolean): OfflineMutation => ({
  canQueue: (body) => favoriteKey(body) !== null,
  apply: async ({ body, server }) => {
    const key = favoriteKey(body);
    if (key) {
      await patchRecorded(
        "/favorites/ids",
        (b) => !b?.type || b.type === key.type,
        (data) => {
          const list: string[] | undefined = Array.isArray(data) ? data : data?.ids ?? data?.items;
          if (!Array.isArray(list)) return;
          const index = list.indexOf(key.id);
          if (add && index < 0) list.push(key.id);
          if (!add && index >= 0) list.splice(index, 1);
        },
      );
      // the full list cannot be rebuilt here; it comes back with the next sync
      if (!add) {
        await patchRecorded(
          "/favorites",
          () => true,
          (data) => {
            if (!Array.isArray(data?.items)) return;
            data.items = data.items.filter(
              (item: any) => (item?.pageId ?? item?.spaceId ?? item?.templateId) !== key.id,
            );
          },
        );
      }
    }
    return { data: server ?? {} };
  },
  describe: (body) => ({ kind: add ? "favorite.add" : "favorite.remove", pageId: body?.pageId }),
});

// ---- rows of a base -----------------------------------------------------------
//
// Offline a base shows the rows as they were last listed; rows written here
// join that list. Formulas, rollups and automations run on the server when
// the change arrives.

async function patchRows(pageId: string, mutate: (items: any[]) => void): Promise<void> {
  await patchRecorded(
    "/bases/rows",
    (b) => b?.pageId === pageId,
    (data) => {
      if (Array.isArray(data?.items)) mutate(data.items);
    },
  );
}

async function lastRowPosition(pageId: string): Promise<string | null> {
  let last: string | null = null;
  for (const record of await recordedFor("/bases/rows")) {
    if ((record.body as any)?.pageId !== pageId) continue;
    for (const row of (record.data as any)?.items ?? []) {
      if (typeof row?.position === "string" && (last === null || row.position > last)) last = row.position;
    }
  }
  return last;
}

const rowCreate: OfflineMutation = {
  canQueue: (body) => Boolean(body?.pageId) && !body?.isTemplate && !body?.fromTemplateId,
  apply: async ({ body, server }) => {
    let row = server;
    let queued = body;
    if (!row) {
      const me = await getMe();
      const now = nowIso();
      const id = looksLikeUuid(body.id) ? body.id : uuidv7();
      row = {
        id,
        pageId: body.pageId,
        cells: body.cells ?? {},
        position: generateJitteredKeyBetween(await lastRowPosition(body.pageId), null),
        creatorId: me?.user?.id ?? null,
        lastUpdatedById: null,
        workspaceId: me?.workspace?.id ?? null,
        createdAt: now,
        updatedAt: now,
        rowNo: null,
        isTemplate: false,
        parentRowId: body.parentRowId ?? null,
        blockedBy: body.blockedBy ?? [],
      };
      queued = { ...body, id };
    }
    if (row?.id && !row.isTemplate) {
      await patchRows(row.pageId, (items) => {
        const index = items.findIndex((item) => item?.id === row.id);
        if (index >= 0) items[index] = row;
        else items.push(row);
      });
    }
    return { data: row, body: queued };
  },
  describe: (body) => ({ kind: "row.create", pageId: body?.pageId }),
};

const rowUpdate: OfflineMutation = {
  canQueue: (body) => Boolean(body?.pageId && body?.rowId),
  apply: async ({ body, server }) => {
    let result: any = server;
    await patchRows(body.pageId, (items) => {
      const index = items.findIndex((item) => item?.id === body.rowId);
      if (index < 0) return;
      const next = server?.id
        ? { ...items[index], ...server }
        : {
            ...items[index],
            cells: { ...(items[index].cells ?? {}), ...(body.cells ?? {}) },
            updatedAt: nowIso(),
          };
      items[index] = next;
      if (!server) result = next;
    });
    return { data: result ?? { id: body.rowId, pageId: body.pageId, cells: body.cells ?? {} } };
  },
  describe: (body) => ({ kind: "row.update", pageId: body?.pageId }),
};

const rowDelete: OfflineMutation = {
  canQueue: (body) => Boolean(body?.pageId && body?.rowId),
  apply: async ({ body, server }) => {
    await patchRows(body.pageId, (items) => {
      const index = items.findIndex((item) => item?.id === body.rowId);
      if (index >= 0) items.splice(index, 1);
    });
    return { data: server };
  },
  describe: (body) => ({ kind: "row.delete", pageId: body?.pageId }),
};

export const MUTATIONS: Record<string, OfflineMutation> = {
  "/pages/create": pageCreate,
  "/pages/update": pageUpdate,
  "/pages/move": pageMove,
  "/pages/delete": pageDelete,
  "/comments/create": commentCreate,
  "/comments/resolve": commentResolve,
  "/comments/update": commentUpdate,
  "/comments/delete": commentDelete,
  "/bases/rows/create": rowCreate,
  "/bases/rows/update": rowUpdate,
  "/bases/rows/delete": rowDelete,
  "/favorites/add": favoriteToggle(true),
  "/favorites/remove": favoriteToggle(false),
};

// Writes that do not matter enough to queue: offline they simply succeed.
export const DROPPED_OFFLINE = new Set([
  "/analytics/track",
  "/ai/vector-cache-hint",
  "/notifications/mark-read",
  "/notifications/mark-all-read",
]);

// A page that left the device's tree for good (trashed elsewhere, access lost).
export async function forgetPageLocally(pageId: string): Promise<void> {
  await forgetRecorded("/comments", (b) => b?.pageId === pageId);
}
