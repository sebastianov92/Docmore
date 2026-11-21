import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import * as Y from 'yjs';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { SpaceRole } from '../../common/helpers/types/permission';
import { OfflinePinDto, SyncDocDto } from './sync.dto';

// How long a change must have been sitting before the cursor moves past it.
// A transaction that touched a row but committed late would otherwise be
// skipped by a device that read in between.
const CURSOR_SETTLE_SECONDS = 10;
const DEFAULT_PULL_LIMIT = 500;
const SPACE_PAGES_LIMIT = 2000;
// base64 of a Yjs update; the request body limit is the real ceiling
const MAX_UPDATE_BASE64 = 7 * 1024 * 1024;

const PAGE_ENTITY_TYPES = ['page', 'page_body', 'page_comments', 'base_data'];

const SKELETON_COLUMNS = [
  'id',
  'slugId',
  'title',
  'icon',
  'position',
  'parentPageId',
  'spaceId',
  'creatorId',
  'isBase',
  'updatedAt',
] as const;

export type SyncChange =
  | { type: 'page'; id: string; deleted: true }
  | { type: 'page'; id: string; page: Record<string, unknown> }
  | { type: 'page_body' | 'page_comments' | 'base_data'; id: string }
  | { type: 'space'; id: string; deleted?: boolean }
  | { type: 'access' | 'members' | 'workspace' };

export type SyncDocResult = {
  pageId: string;
  // ok: applied and/or answered; read_only: the update was refused, the answer
  // still carries the server state; deleted: the page is in the trash;
  // forbidden / missing: nothing the device may see
  status: 'ok' | 'read_only' | 'deleted' | 'forbidden' | 'missing' | 'invalid';
  update?: string;
};

type PageAccess = { spaceId: string; canEdit: boolean };

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly collaborationGateway: CollaborationGateway,
  ) {}

  // ---- cursor -------------------------------------------------------------

  private async settledCursor(workspaceId: string): Promise<bigint> {
    const row = await sql<{ seq: string | null }>`
      SELECT max(seq)::text AS seq FROM sync_changes
      WHERE workspace_id = ${workspaceId}
        AND changed_at <= now() - make_interval(secs => ${CURSOR_SETTLE_SECONDS})
    `.execute(this.db);
    return BigInt(row.rows[0]?.seq ?? '0');
  }

  // ---- snapshot -----------------------------------------------------------

  // Where a device starts: the cursor to pull from afterwards and the spaces
  // whose page trees it should load with spacePages().
  async snapshot(user: User, workspace: Workspace) {
    // taken BEFORE the device reads anything: whatever changes while it loads
    // comes again in the first pull
    const cursor = await this.settledCursor(workspace.id);
    const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
    const roles = await this.spaceRoles(user.id, spaceIds);
    return {
      cursor: cursor.toString(),
      spaces: spaceIds.map((id) => ({ id, canEdit: roleCanEdit(roles.get(id)) })),
    };
  }

  // The whole tree of one space, flat, in chunks. Each item has the shape of
  // a sidebar page so a device can answer the sidebar from it.
  async spacePages(user: User, workspace: Workspace, spaceId: string, after?: string, limit = SPACE_PAGES_LIMIT) {
    const roles = await this.spaceRoles(user.id, [spaceId]);
    const role = roles.get(spaceId);
    if (!role) throw new ForbiddenException();
    const spaceCanEdit = roleCanEdit(role);

    let query = this.db
      .selectFrom('pages')
      .select([...SKELETON_COLUMNS])
      .where('spaceId', '=', spaceId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .orderBy('id', 'asc')
      .limit(limit + 1);
    if (after) query = query.where('id', '>', after);
    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    let items: Array<Record<string, unknown>>;
    const restricted = await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);
    if (!restricted) {
      items = page.map((p) => ({ ...p, canEdit: spaceCanEdit }));
    } else {
      const allowed = await this.pagePermissionRepo.filterAccessiblePageIdsWithPermissions(
        page.map((p) => p.id),
        user.id,
      );
      const canEditById = new Map(allowed.map((a) => [a.id, a.canEdit]));
      items = page
        .filter((p) => canEditById.has(p.id))
        .map((p) => ({ ...p, canEdit: Boolean(canEditById.get(p.id)) && spaceCanEdit }));
    }

    return { items, next: hasMore ? page[page.length - 1].id : null };
  }

  // ---- pull ---------------------------------------------------------------

  async pull(user: User, workspace: Workspace, cursorText: string, limit = DEFAULT_PULL_LIMIT) {
    const cursor = BigInt(cursorText);
    const settled = await this.settledCursor(workspace.id);

    const rows = await this.db
      .selectFrom('syncChanges')
      .select(['entityType', 'entityId', 'deleted', sql<string>`seq::text`.as('seq')])
      .where('workspaceId', '=', workspace.id)
      .where(sql<boolean>`seq > ${cursor.toString()}::bigint`)
      .orderBy(sql`seq`, 'asc')
      .limit(limit)
      .execute();

    const lastSeq = rows.length ? BigInt(rows[rows.length - 1].seq) : cursor;
    let nextCursor: bigint;
    let more = false;
    if (rows.length === limit && lastSeq <= settled) {
      nextCursor = lastSeq;
      more = true;
    } else {
      // everything settled has been sent; fresher rows went out too and will
      // come again until they settle
      nextCursor = settled > cursor ? settled : cursor;
    }

    const pageIds = [
      ...new Set(rows.filter((r) => PAGE_ENTITY_TYPES.includes(r.entityType)).map((r) => r.entityId)),
    ];
    const { access, skeletons } = await this.pagesForUser(user, workspace, pageIds);
    const userSpaceIds = new Set(await this.spaceMemberRepo.getUserSpaceIds(user.id));

    const changes: SyncChange[] = [];
    const coarse = new Set<string>();
    for (const row of rows) {
      switch (row.entityType) {
        case 'page': {
          const visible = access.get(row.entityId);
          const skeleton = skeletons.get(row.entityId);
          if (row.deleted || !visible || !skeleton) {
            changes.push({ type: 'page', id: row.entityId, deleted: true });
          } else {
            changes.push({ type: 'page', id: row.entityId, page: { ...skeleton, canEdit: visible.canEdit } });
          }
          break;
        }
        case 'page_body':
        case 'page_comments':
        case 'base_data':
          if (access.has(row.entityId)) {
            changes.push({ type: row.entityType, id: row.entityId });
          }
          break;
        case 'space':
          if (row.deleted || userSpaceIds.has(row.entityId)) {
            changes.push({ type: 'space', id: row.entityId, ...(row.deleted ? { deleted: true } : {}) });
          }
          break;
        case 'access':
        case 'members':
        case 'workspace':
          if (!coarse.has(row.entityType)) {
            coarse.add(row.entityType);
            changes.push({ type: row.entityType });
          }
          break;
        default:
          break;
      }
    }

    return { cursor: nextCursor.toString(), more, changes };
  }

  // ---- page bodies --------------------------------------------------------

  // Yjs for pages that are not open in an editor: the device sends what it
  // wrote and what it has, the server applies the first through the collab
  // server (same path as live editing) and answers with what is missing.
  async syncDocs(user: User, workspace: Workspace, docs: SyncDocDto[]): Promise<SyncDocResult[]> {
    const ids = [...new Set(docs.map((d) => d.pageId))];
    const pages = ids.length
      ? await this.db
          .selectFrom('pages')
          .select(['id', 'spaceId', 'deletedAt', 'ydoc', sql<boolean>`content IS NOT NULL`.as('hasContent')])
          .where('id', 'in', ids)
          .where('workspaceId', '=', workspace.id)
          .execute()
      : [];
    const pageById = new Map(pages.map((p) => [p.id, p]));
    const { access } = await this.pagesForUser(user, workspace, ids, { includeDeleted: true });

    const results: SyncDocResult[] = [];
    for (const doc of docs) {
      const page = pageById.get(doc.pageId);
      if (!page) {
        results.push({ pageId: doc.pageId, status: 'missing' });
        continue;
      }
      const pageAccess = access.get(doc.pageId);
      if (!pageAccess) {
        results.push({ pageId: doc.pageId, status: 'forbidden' });
        continue;
      }
      if (page.deletedAt) {
        // nothing is applied to a page in the trash; the device decides
        results.push({ pageId: doc.pageId, status: 'deleted' });
        continue;
      }
      try {
        results.push(await this.syncOne(user, doc, page, pageAccess));
      } catch (err) {
        this.logger.warn(`sync of page ${doc.pageId} failed: ${(err as Error)?.message}`);
        results.push({ pageId: doc.pageId, status: 'invalid' });
      }
    }
    return results;
  }

  private async syncOne(
    user: User,
    doc: SyncDocDto,
    page: { id: string; ydoc: Buffer | null; hasContent: boolean },
    pageAccess: PageAccess,
  ): Promise<SyncDocResult> {
    const stateVector = doc.stateVector ? decodeBase64(doc.stateVector) : undefined;
    let status: SyncDocResult['status'] = 'ok';
    let update = doc.update;
    if (update) {
      if (update.length > MAX_UPDATE_BASE64) return { pageId: page.id, status: 'invalid' };
      if (!pageAccess.canEdit) {
        status = 'read_only';
        update = undefined;
      }
    }

    // Through the collab server when there is something to write, and when the
    // page has content but no Yjs state yet (the collab server creates and
    // stores that state exactly once).
    if (update || (!page.ydoc && page.hasContent)) {
      const result = (await this.collaborationGateway.handleYjsEvent('syncClientUpdate', `page.${page.id}`, {
        update,
        stateVector: doc.stateVector,
        user,
      })) as { update: string | null } | undefined;
      return { pageId: page.id, status, ...(result?.update ? { update: result.update } : {}) };
    }

    if (!page.ydoc) return { pageId: page.id, status };

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(page.ydoc));
    const diff = Y.encodeStateAsUpdate(ydoc, stateVector);
    ydoc.destroy();
    return { pageId: page.id, status, ...(isEmptyUpdate(diff) ? {} : { update: Buffer.from(diff).toString('base64') }) };
  }

  // ---- pins ---------------------------------------------------------------

  async listPins(user: User, workspace: Workspace, deviceId: string) {
    const rows = await this.db
      .selectFrom('offlinePins')
      .select(['entityType', 'entityId'])
      .where('userId', '=', user.id)
      .where('workspaceId', '=', workspace.id)
      .where('deviceId', '=', deviceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return { pins: rows.map((r) => ({ type: r.entityType, id: r.entityId })) };
  }

  async setPins(user: User, workspace: Workspace, deviceId: string, deviceName: string | undefined, pins: OfflinePinDto[]) {
    const unique = new Map(pins.map((p) => [`${p.type}:${p.id}`, p]));
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('offlinePins')
        .where('userId', '=', user.id)
        .where('workspaceId', '=', workspace.id)
        .where('deviceId', '=', deviceId)
        .execute();
      if (unique.size > 0) {
        await trx
          .insertInto('offlinePins')
          .values(
            [...unique.values()].map((p) => ({
              workspaceId: workspace.id,
              userId: user.id,
              deviceId,
              deviceName: deviceName ?? null,
              entityType: p.type,
              entityId: p.id,
            })),
          )
          .execute();
      }
    });
    return { pins: [...unique.values()] };
  }

  // ---- access -------------------------------------------------------------

  private async spaceRoles(userId: string, spaceIds: string[]): Promise<Map<string, string>> {
    const rank: Record<string, number> = {
      [SpaceRole.READER]: 1,
      [SpaceRole.COMMENTER]: 2,
      [SpaceRole.WRITER]: 3,
      [SpaceRole.ADMIN]: 4,
    };
    const best = new Map<string, string>();
    for (const row of await this.spaceMemberRepo.getUserRolesForSpaces(userId, spaceIds)) {
      const current = best.get(row.spaceId);
      if (!current || (rank[row.role] ?? 0) > (rank[current] ?? 0)) best.set(row.spaceId, row.role);
    }
    return best;
  }

  // Which of these pages the person may see (and edit), with the same rules
  // as the sidebar: member of the space, and no restricted ancestor that
  // leaves them out.
  private async pagesForUser(
    user: User,
    workspace: Workspace,
    pageIds: string[],
    opts: { includeDeleted?: boolean } = {},
  ): Promise<{ access: Map<string, PageAccess>; skeletons: Map<string, Record<string, unknown>> }> {
    const access = new Map<string, PageAccess>();
    const skeletons = new Map<string, Record<string, unknown>>();
    if (pageIds.length === 0) return { access, skeletons };

    let query = this.db
      .selectFrom('pages')
      .select([...SKELETON_COLUMNS, 'deletedAt'])
      .where('id', 'in', pageIds)
      .where('workspaceId', '=', workspace.id);
    if (!opts.includeDeleted) query = query.where('deletedAt', 'is', null);
    const pages = await query.execute();
    if (pages.length === 0) return { access, skeletons };

    const roles = await this.spaceRoles(user.id, [...new Set(pages.map((p) => p.spaceId))]);
    const inMySpaces = pages.filter((p) => roles.has(p.spaceId));
    const allowed = await this.pagePermissionRepo.filterAccessiblePageIdsWithPermissions(
      inMySpaces.map((p) => p.id),
      user.id,
    );
    const canEditById = new Map(allowed.map((a) => [a.id, a.canEdit]));
    for (const page of inMySpaces) {
      if (!canEditById.has(page.id)) continue;
      const spaceCanEdit = roleCanEdit(roles.get(page.spaceId));
      access.set(page.id, { spaceId: page.spaceId, canEdit: Boolean(canEditById.get(page.id)) && spaceCanEdit });
      const { deletedAt: _deletedAt, ...skeleton } = page;
      skeletons.set(page.id, skeleton);
    }
    return { access, skeletons };
  }

  async assertPageVisible(user: User, workspace: Workspace, pageId: string): Promise<void> {
    const { access } = await this.pagesForUser(user, workspace, [pageId]);
    if (!access.has(pageId)) throw new NotFoundException('Page not found');
  }
}

function roleCanEdit(role: string | undefined): boolean {
  return role === SpaceRole.ADMIN || role === SpaceRole.WRITER;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

// An update with no structs and no deletions encodes as two zero bytes.
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length <= 2;
}
