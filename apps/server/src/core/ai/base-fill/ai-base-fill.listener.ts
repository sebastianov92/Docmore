import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { EventName } from '../../../common/events/event.contants';
import { BaseRowCreatedEvent, BaseRowUpdatedEvent } from '../../base/events/base-events';
import { AiBaseFillService } from './ai-base-fill.service';

// Properties with "auto-update" refill when their source cells change.
@Injectable()
export class AiBaseFillListener {
  private readonly logger = new Logger(AiBaseFillListener.name);

  constructor(
    private readonly fill: AiBaseFillService,
    private readonly basePropertyRepo: BasePropertyRepo,
  ) {}

  @OnEvent(EventName.BASE_ROW_CREATED, { async: true })
  async onCreated(e: BaseRowCreatedEvent) {
    await this.schedule(e.pageId, e.workspaceId, e.row.id, Object.keys((e.row.cells ?? {}) as object), e.actorId ?? null, e.automationDepth);
  }

  @OnEvent(EventName.BASE_ROW_UPDATED, { async: true })
  async onUpdated(e: BaseRowUpdatedEvent) {
    await this.schedule(e.pageId, e.workspaceId, e.rowId, Object.keys(e.patch ?? {}), e.actorId ?? null, e.automationDepth);
  }

  private async schedule(pageId: string, workspaceId: string, rowId: string, touched: string[], actorId: string | null, depth?: number) {
    if ((depth ?? 0) > 0 || touched.length === 0) return;
    try {
      const properties = await this.basePropertyRepo.findByPageId(pageId);
      for (const p of properties) {
        const ai = ((p.typeOptions ?? {}) as any).ai as { prompt?: string; autoUpdate?: boolean; sourcePropertyIds?: string[] } | undefined;
        if (!ai?.prompt || !ai.autoUpdate) continue;
        if (touched.length === 1 && touched[0] === p.id) continue; // its own value changed
        const sources = ai.sourcePropertyIds?.length ? ai.sourcePropertyIds : properties.filter((x) => x.id !== p.id).map((x) => x.id);
        if (!touched.some((id) => sources.includes(id))) continue;
        await this.fill.enqueue({ pageId, propertyId: p.id, workspaceId, userId: actorId, rowIds: [rowId], onlyEmpty: false }, { delayMs: 4000 });
      }
    } catch (err: any) {
      this.logger.warn(`AI autofill scheduling failed: ${err?.message}`);
    }
  }
}
