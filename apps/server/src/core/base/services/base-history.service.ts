import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BaseRowVersionRepo, RowVersionListItem } from '@docmost/db/repos/base/base-row-version.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRow } from '@docmost/db/types/entity.types';
import { EventName } from '../../../common/events/event.contants';
import { BaseRowCreatedEvent, BaseRowUpdatedEvent } from '../events/base-events';

export type HistoryKind = 'update' | 'delete' | 'convert' | 'restore';

// Cell snapshots taken before edits, deletes and conversions, and the two
// ways back: one version onto its row, or every row deleted since a moment.
@Injectable()
export class BaseHistoryService {
  constructor(
    private readonly versions: BaseRowVersionRepo,
    private readonly baseRowRepo: BaseRowRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Before an edit: only when some cell really changes.
  async recordUpdate(row: BaseRow, nextCells: Record<string, unknown>, actorId: string | null | undefined): Promise<void> {
    const cells = (row.cells ?? {}) as Record<string, unknown>;
    const changed = Object.keys(nextCells).some(
      (k) => JSON.stringify(cells[k] ?? null) !== JSON.stringify(nextCells[k] ?? null),
    );
    if (!changed) return;
    await this.versions.insertMany([
      { rowId: row.id, pageId: row.pageId, workspaceId: row.workspaceId, cells, kind: 'update', actorId: actorId ?? null },
    ]);
  }

  async recordDelete(rows: BaseRow[], actorId: string | null | undefined): Promise<void> {
    await this.versions.insertMany(
      rows.map((r) => ({
        rowId: r.id,
        pageId: r.pageId,
        workspaceId: r.workspaceId,
        cells: r.cells ?? {},
        kind: 'delete',
        actorId: actorId ?? null,
      })),
    );
  }

  async recordConvert(pageId: string, workspaceId: string, actorId: string | null | undefined): Promise<number> {
    return this.versions.snapshotPage(pageId, workspaceId, 'convert', actorId ?? null);
  }

  async list(opts: { pageId: string; workspaceId: string; rowId?: string; before?: string; limit?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const items: RowVersionListItem[] = await this.versions.list({
      pageId: opts.pageId,
      workspaceId: opts.workspaceId,
      rowId: opts.rowId,
      before: opts.before ? new Date(opts.before) : undefined,
      limit: limit + 1,
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const primary = (await this.basePropertyRepo.findByPageId(opts.pageId)).find((p) => p.isPrimary);
    return {
      items: page.map((v) => ({
        id: v.id,
        rowId: v.rowId,
        kind: v.kind,
        cells: v.cells,
        title: primary ? titleOf((v.cells ?? {})[primary.id]) : '',
        actorId: v.actorId,
        actorName: v.actorName,
        actorAvatarUrl: v.actorAvatarUrl,
        createdAt: v.createdAt,
        rowDeleted: Boolean(v.rowDeleted),
      })),
      meta: { hasNextPage: hasMore, nextBefore: hasMore ? page[page.length - 1]?.createdAt : null },
    };
  }

  // Puts a version's cells back on its row, bringing the row back if it
  // was deleted; the current cells are kept as a 'restore' version.
  async restore(versionId: string, pageId: string, workspaceId: string, actorId: string | null) {
    const version = await this.versions.findById(versionId, workspaceId);
    if (!version || version.pageId !== pageId) throw new NotFoundException('Version not found');
    const row = await this.baseRowRepo.findByIdIncludingDeleted(version.rowId, { workspaceId });
    if (!row) throw new NotFoundException('Row no longer exists');
    const wasDeleted = Boolean(row.deletedAt);
    await this.versions.insertMany([
      { rowId: row.id, pageId, workspaceId, cells: row.cells ?? {}, kind: 'restore', actorId },
    ]);
    // cells of properties that no longer exist are dropped
    const live = new Set((await this.basePropertyRepo.findByPageId(pageId)).map((p) => p.id));
    const cells: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((version.cells ?? {}) as Record<string, unknown>)) if (live.has(k)) cells[k] = v;
    const updated = await this.baseRowRepo.replaceCells(row.id, cells, { pageId, workspaceId, actorId, undelete: wasDeleted });
    if (!updated) throw new BadRequestException('Could not restore the row');
    if (wasDeleted) {
      const event: BaseRowCreatedEvent = { pageId, workspaceId, actorId, requestId: null, row: updated };
      this.eventEmitter.emit(EventName.BASE_ROW_CREATED, event);
    } else {
      const event: BaseRowUpdatedEvent = { pageId, workspaceId, actorId, requestId: null, rowId: row.id, patch: cells, updatedCells: cells };
      this.eventEmitter.emit(EventName.BASE_ROW_UPDATED, event);
    }
    return { row: updated, restoredDeleted: wasDeleted };
  }

  // Undo a mass delete: every row of the base deleted since the moment.
  async restoreDeleted(pageId: string, workspaceId: string, since: Date, actorId: string | null) {
    if (Number.isNaN(since.getTime())) throw new BadRequestException('Bad date');
    const rows = await this.baseRowRepo.findDeletedSince(pageId, workspaceId, since);
    const count = await this.baseRowRepo.undeleteMany(rows.map((r) => r.id), pageId, workspaceId);
    for (const row of rows) {
      const event: BaseRowCreatedEvent = { pageId, workspaceId, actorId, requestId: null, row };
      this.eventEmitter.emit(EventName.BASE_ROW_CREATED, event);
    }
    return { count };
  }
}

function titleOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
