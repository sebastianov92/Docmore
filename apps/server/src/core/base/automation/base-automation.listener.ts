import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { BaseRowCreatedEvent, BaseRowUpdatedEvent } from '../events/base-events';
import { BaseAutomationService } from './base-automation.service';

// Feeds row events to the automations of the base (errors never reach the
// request that caused the event).
@Injectable()
export class BaseAutomationListener {
  private readonly logger = new Logger(BaseAutomationListener.name);

  constructor(private readonly automations: BaseAutomationService) {}

  @OnEvent(EventName.BASE_ROW_CREATED, { async: true })
  async onRowCreated(e: BaseRowCreatedEvent) {
    try {
      await this.automations.runForEvent('row.created', { ...e, rowId: e.row.id });
    } catch (err: any) {
      this.logger.warn(`automations on row created failed: ${err?.message}`);
    }
  }

  @OnEvent(EventName.BASE_ROW_UPDATED, { async: true })
  async onRowUpdated(e: BaseRowUpdatedEvent) {
    try {
      await this.automations.runForEvent('row.updated', e);
    } catch (err: any) {
      this.logger.warn(`automations on row updated failed: ${err?.message}`);
    }
  }
}
