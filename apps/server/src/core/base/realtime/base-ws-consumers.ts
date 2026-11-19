import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { BaseWsService } from './base-ws.service';
import {
  BaseFormulaRecomputeCompletedEvent,
  BaseFormulaRecomputeStartedEvent,
  BasePropertyCreatedEvent,
  BasePropertyDeletedEvent,
  BasePropertyReorderedEvent,
  BasePropertyUpdatedEvent,
  BaseRowCreatedEvent,
  BaseRowDeletedEvent,
  BaseRowsDeletedEvent,
  BaseRowsUpdatedEvent,
  BaseRowReorderedEvent,
  BaseRowUpdatedEvent,
  BaseSchemaBumpedEvent,
  BaseViewCreatedEvent,
  BaseViewDeletedEvent,
  BaseViewUpdatedEvent,
  BaseImportCompletedEvent,
  BaseImportProgressEvent,
} from '../events/base-events';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';

/*
 * In-process listeners that forward base domain events onto the
 * `base-{pageId}` socket.io room. Originating clients suppress their own
 * echoes via `requestId`.
 */
@Injectable()
export class BaseWsConsumers {
  private readonly logger = new Logger(BaseWsConsumers.name);

  constructor(
    private readonly ws: BaseWsService,
    private readonly basePropertyRepo: BasePropertyRepo,
  ) {}

  // Ids of the columns some readers may not see.
  private async restrictedIds(pageId: string): Promise<Set<string>> {
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    return new Set(
      properties
        .filter((p) => (p as any).restrictedTo && (p as any).restrictedTo !== 'all')
        .map((p) => p.id),
    );
  }

  private strip(cells: Record<string, unknown> | undefined, restricted: Set<string>) {
    const out: Record<string, unknown> = {};
    const touched: string[] = [];
    for (const [k, v] of Object.entries(cells ?? {})) {
      if (restricted.has(k)) touched.push(k);
      else out[k] = v;
    }
    return { cells: out, touched };
  }

  @OnEvent(EventName.BASE_ROW_CREATED)
  async onRowCreated(e: BaseRowCreatedEvent) {
    const restricted = await this.restrictedIds(e.pageId);
    const { cells, touched } = this.strip((e.row as any)?.cells, restricted);
    this.ws.emitToBase(e.pageId, {
      operation: 'base:row:created',
      pageId: e.pageId,
      row: restricted.size ? { ...e.row, cells } : e.row,
      restrictedCellIds: touched,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_ROW_UPDATED)
  async onRowUpdated(e: BaseRowUpdatedEvent) {
    const restricted = await this.restrictedIds(e.pageId);
    const patch = this.strip(e.patch, restricted);
    const updated = this.strip(e.updatedCells, restricted);
    this.ws.emitToBase(e.pageId, {
      operation: 'base:row:updated',
      pageId: e.pageId,
      rowId: e.rowId,
      patch: patch.cells,
      updatedCells: updated.cells,
      restrictedCellIds: [...new Set([...patch.touched, ...updated.touched])],
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_ROW_DELETED)
  onRowDeleted(e: BaseRowDeletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:row:deleted',
      pageId: e.pageId,
      rowId: e.rowId,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_ROWS_DELETED)
  onRowsDeleted(e: BaseRowsDeletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:rows:deleted',
      pageId: e.pageId,
      rowIds: e.rowIds,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_ROW_REORDERED)
  onRowReordered(e: BaseRowReorderedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:row:reordered',
      pageId: e.pageId,
      rowId: e.rowId,
      position: e.position,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_CREATED)
  onPropertyCreated(e: BasePropertyCreatedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:property:created',
      pageId: e.pageId,
      property: e.property,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_UPDATED)
  onPropertyUpdated(e: BasePropertyUpdatedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:property:updated',
      pageId: e.pageId,
      property: e.property,
      schemaVersion: e.schemaVersion,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_DELETED)
  onPropertyDeleted(e: BasePropertyDeletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:property:deleted',
      pageId: e.pageId,
      propertyId: e.propertyId,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_REORDERED)
  onPropertyReordered(e: BasePropertyReorderedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:property:reordered',
      pageId: e.pageId,
      propertyId: e.propertyId,
      position: e.position,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_VIEW_CREATED)
  onViewCreated(e: BaseViewCreatedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:view:created',
      pageId: e.pageId,
      view: e.view,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_VIEW_UPDATED)
  onViewUpdated(e: BaseViewUpdatedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:view:updated',
      pageId: e.pageId,
      view: e.view,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_VIEW_DELETED)
  onViewDeleted(e: BaseViewDeletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:view:deleted',
      pageId: e.pageId,
      viewId: e.viewId,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_SCHEMA_BUMPED)
  onSchemaBumped(e: BaseSchemaBumpedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:schema:bumped',
      pageId: e.pageId,
      schemaVersion: e.schemaVersion,
    });
  }

  @OnEvent(EventName.BASE_ROWS_UPDATED)
  onRowsUpdated(e: BaseRowsUpdatedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:rows:updated',
      pageId: e.pageId,
      rowIds: e.rowIds,
      propertyIds: e.propertyIds,
      actorId: e.actorId ?? null,
      requestId: e.requestId ?? null,
    });
  }

  @OnEvent(EventName.BASE_FORMULA_RECOMPUTE_STARTED)
  onFormulaRecomputeStarted(e: BaseFormulaRecomputeStartedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:formula:recompute:started',
      pageId: e.pageId,
      propertyIds: e.propertyIds,
      jobId: e.jobId,
      actorId: e.actorId ?? null,
    });
  }

  @OnEvent(EventName.BASE_FORMULA_RECOMPUTE_COMPLETED)
  onFormulaRecomputeCompleted(e: BaseFormulaRecomputeCompletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:formula:recompute:completed',
      pageId: e.pageId,
      propertyIds: e.propertyIds,
      jobId: e.jobId,
      processed: e.processed,
      errored: e.errored,
      actorId: e.actorId ?? null,
    });
  }

  @OnEvent(EventName.BASE_IMPORT_PROGRESS)
  onImportProgress(e: BaseImportProgressEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:import:progress',
      pageId: e.pageId,
      fileTaskId: e.fileTaskId,
      processedRows: e.processedRows,
      totalRows: e.totalRows,
    });
  }

  @OnEvent(EventName.BASE_IMPORT_COMPLETED)
  onImportCompleted(e: BaseImportCompletedEvent) {
    this.ws.emitToBase(e.pageId, {
      operation: 'base:import:completed',
      pageId: e.pageId,
      fileTaskId: e.fileTaskId,
      status: e.status,
      totalRows: e.totalRows,
      importedRows: e.importedRows,
      skippedValues: e.skippedValues,
      error: e.error,
    });
  }
}
