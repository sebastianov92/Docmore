import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { WebhookService } from './webhook.service';

// Forwards domain events to the workspace's webhooks.
@Injectable()
export class WebhookListener {
  private readonly logger = new Logger(WebhookListener.name);

  constructor(private readonly webhooks: WebhookService) {}

  private async forward(event: string, payload: any) {
    const workspaceId: string | undefined =
      payload?.workspaceId ?? payload?.page?.workspaceId ?? payload?.space?.workspaceId ?? payload?.row?.workspaceId;
    if (!workspaceId) return;
    try {
      await this.webhooks.dispatch(event, workspaceId, payload);
    } catch (err: any) {
      this.logger.warn(`webhook dispatch for ${event} failed: ${err?.message}`);
    }
  }

  @OnEvent(EventName.PAGE_CREATED, { async: true })
  onPageCreated(e: unknown) {
    return this.forward('page.created', e);
  }
  @OnEvent(EventName.PAGE_UPDATED, { async: true })
  onPageUpdated(e: unknown) {
    return this.forward('page.updated', e);
  }
  @OnEvent(EventName.PAGE_DELETED, { async: true })
  onPageDeleted(e: unknown) {
    return this.forward('page.deleted', e);
  }
  @OnEvent(EventName.PAGE_SOFT_DELETED, { async: true })
  onPageSoftDeleted(e: unknown) {
    return this.forward('page.soft_deleted', e);
  }
  @OnEvent(EventName.PAGE_RESTORED, { async: true })
  onPageRestored(e: unknown) {
    return this.forward('page.restored', e);
  }
  @OnEvent(EventName.SPACE_CREATED, { async: true })
  onSpaceCreated(e: unknown) {
    return this.forward('space.created', e);
  }
  @OnEvent(EventName.SPACE_UPDATED, { async: true })
  onSpaceUpdated(e: unknown) {
    return this.forward('space.updated', e);
  }
  @OnEvent(EventName.SPACE_DELETED, { async: true })
  onSpaceDeleted(e: unknown) {
    return this.forward('space.deleted', e);
  }
  @OnEvent(EventName.BASE_CREATED, { async: true })
  onBaseCreated(e: unknown) {
    return this.forward('base.created', e);
  }
  @OnEvent(EventName.BASE_DELETED, { async: true })
  onBaseDeleted(e: unknown) {
    return this.forward('base.deleted', e);
  }
  @OnEvent(EventName.BASE_ROW_CREATED, { async: true })
  onRowCreated(e: unknown) {
    return this.forward('base.row.created', e);
  }
  @OnEvent(EventName.BASE_ROW_UPDATED, { async: true })
  onRowUpdated(e: unknown) {
    return this.forward('base.row.updated', e);
  }
  @OnEvent(EventName.BASE_ROW_DELETED, { async: true })
  onRowDeleted(e: unknown) {
    return this.forward('base.row.deleted', e);
  }
  @OnEvent(EventName.BASE_ROWS_DELETED, { async: true })
  onRowsDeleted(e: unknown) {
    return this.forward('base.rows.deleted', e);
  }
  @OnEvent(EventName.NOTIFICATION_CREATED, { async: true })
  onNotification(e: unknown) {
    return this.forward('notification.created', e);
  }
}
