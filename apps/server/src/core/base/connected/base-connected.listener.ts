import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { BaseRowCreatedEvent, BaseRowUpdatedEvent } from '../events/base-events';
import { BaseConnectedService } from './base-connected.service';

// A connected cell that just got its link is fetched right away.
@Injectable()
export class BaseConnectedListener {
  private readonly logger = new Logger(BaseConnectedListener.name);

  constructor(private readonly connected: BaseConnectedService) {}

  @OnEvent(EventName.BASE_ROW_CREATED, { async: true })
  async onRowCreated(e: BaseRowCreatedEvent) {
    try {
      await this.connected.scheduleForCells(e.pageId, e.workspaceId, e.row.id, (e.row.cells ?? {}) as Record<string, unknown>, e.actorId ?? null);
    } catch (err: any) {
      this.logger.warn(`connected scheduling failed: ${err?.message}`);
    }
  }

  @OnEvent(EventName.BASE_ROW_UPDATED, { async: true })
  async onRowUpdated(e: BaseRowUpdatedEvent) {
    try {
      await this.connected.scheduleForCells(e.pageId, e.workspaceId, e.rowId, e.updatedCells ?? {}, e.actorId ?? null);
    } catch (err: any) {
      this.logger.warn(`connected scheduling failed: ${err?.message}`);
    }
  }
}
