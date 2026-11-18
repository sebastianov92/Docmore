import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EventName } from '../../../common/events/event.contants';
import {
  AuditEvent,
  AuditLogPayload,
  AuditResource,
} from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import {
  BasePropertyCreatedEvent,
  BasePropertyDeletedEvent,
  BasePropertyUpdatedEvent,
  BaseRowDeletedEvent,
  BaseRowsDeletedEvent,
  BaseViewCreatedEvent,
  BaseViewDeletedEvent,
} from '../events/base-events';

type BaseEvent = {
  pageId: string;
  workspaceId: string;
  actorId?: string | null;
};

// Writes audit rows for schema changes and deletions. Single cell edits
// and view layout autosaves are left out: they would drown everything else.
@Injectable()
export class BaseAuditListener {
  constructor(
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly pageRepo: PageRepo,
  ) {}

  @OnEvent(EventName.BASE_PROPERTY_CREATED)
  onPropertyCreated(event: BasePropertyCreatedEvent) {
    return this.log(AuditEvent.BASE_PROPERTY_CREATED, event, {
      propertyId: event.property.id,
      name: event.property.name,
      type: event.property.type,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_UPDATED)
  onPropertyUpdated(event: BasePropertyUpdatedEvent) {
    return this.log(AuditEvent.BASE_PROPERTY_UPDATED, event, {
      propertyId: event.property.id,
      name: event.property.name,
      type: event.property.type,
      pendingType: event.property.pendingType ?? undefined,
    });
  }

  @OnEvent(EventName.BASE_PROPERTY_DELETED)
  onPropertyDeleted(event: BasePropertyDeletedEvent) {
    return this.log(AuditEvent.BASE_PROPERTY_DELETED, event, {
      propertyId: event.propertyId,
    });
  }

  @OnEvent(EventName.BASE_VIEW_CREATED)
  onViewCreated(event: BaseViewCreatedEvent) {
    return this.log(AuditEvent.BASE_VIEW_CREATED, event, {
      viewId: event.view.id,
      name: event.view.name,
      type: event.view.type,
    });
  }

  @OnEvent(EventName.BASE_VIEW_DELETED)
  onViewDeleted(event: BaseViewDeletedEvent) {
    return this.log(AuditEvent.BASE_VIEW_DELETED, event, {
      viewId: event.viewId,
    });
  }

  @OnEvent(EventName.BASE_ROW_DELETED)
  onRowDeleted(event: BaseRowDeletedEvent) {
    return this.log(AuditEvent.BASE_ROWS_DELETED, event, { count: 1 });
  }

  @OnEvent(EventName.BASE_ROWS_DELETED)
  onRowsDeleted(event: BaseRowsDeletedEvent) {
    return this.log(AuditEvent.BASE_ROWS_DELETED, event, {
      count: event.rowIds.length,
    });
  }

  private async log(
    auditEvent: AuditLogPayload['event'],
    event: BaseEvent,
    metadata: Record<string, unknown>,
  ) {
    try {
      const page = await this.pageRepo.findById(event.pageId);
      await this.auditService.logWithContext(
        {
          event: auditEvent,
          resourceType: AuditResource.BASE,
          resourceId: event.pageId,
          spaceId: page?.spaceId,
          metadata: { pageId: event.pageId, ...metadata },
        },
        {
          workspaceId: event.workspaceId,
          actorId: event.actorId ?? undefined,
        },
      );
    } catch {
      // audit is best effort
    }
  }
}
