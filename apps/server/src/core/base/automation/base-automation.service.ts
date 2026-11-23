import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { assertPublicUrl } from '../../../common/helpers/public-url';
import { BaseAutomationRepo, AutomationRow } from '@docmost/db/repos/base/base-automation.repo';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { BaseProperty, BaseRow } from '@docmost/db/types/entity.types';
import { NotificationService } from '../../notification/notification.service';
import { BaseRowService } from '../services/base-row.service';
import { isSystemPropertyType } from '../base.schemas';
import { AutomationAction, automationSpecSchema, MAX_AUTOMATION_DEPTH } from './automation.schemas';
import { matchesFilter, renderTemplate } from './automation-eval';
import { CreateAutomationDto, UpdateAutomationDto } from '../dto/automation.dto';

export const BASE_AUTOMATION_NOTIFICATION = 'base.automation';

// `made`: the rows the actions add, for whoever pressed the button to be
// shown what it did.
type RunContext = { workspaceId: string; actorId: string | null; depth: number; made?: Array<{ pageId: string; rowId: string }> };

// Rules of a base: a trigger, optional conditions on the row, and actions.
// Rows written by actions carry the depth so chains stop after a few hops.
@Injectable()
export class BaseAutomationService {
  private readonly logger = new Logger(BaseAutomationService.name);

  constructor(
    private readonly repo: BaseAutomationRepo,
    private readonly baseRowRepo: BaseRowRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseRepo: BaseRepo,
    private readonly baseRowService: BaseRowService,
    private readonly notifications: NotificationService,
  ) {}

  list(pageId: string, workspaceId: string) {
    return this.repo.findByPage(pageId, workspaceId);
  }

  async create(dto: CreateAutomationDto, workspaceId: string, userId: string) {
    const spec = this.parseSpec({ trigger: dto.trigger, conditions: dto.conditions ?? null, actions: dto.actions });
    await this.assertActionTargets(spec.actions, dto.pageId, workspaceId);
    return this.repo.insert({
      pageId: dto.pageId,
      workspaceId,
      name: dto.name,
      enabled: dto.enabled ?? true,
      trigger: spec.trigger,
      conditions: spec.conditions ?? null,
      actions: spec.actions,
      creatorId: userId,
    });
  }

  async update(dto: UpdateAutomationDto, workspaceId: string) {
    const current = await this.repo.findById(dto.automationId, workspaceId);
    if (!current || current.pageId !== dto.pageId) throw new NotFoundException('Automation not found');
    const spec = this.parseSpec({
      trigger: dto.trigger ?? current.trigger,
      conditions: dto.conditions === undefined ? current.conditions : dto.conditions,
      actions: dto.actions ?? current.actions,
    });
    await this.assertActionTargets(spec.actions, dto.pageId, workspaceId);
    return this.repo.update(dto.automationId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      trigger: spec.trigger,
      conditions: spec.conditions ?? null,
      actions: spec.actions,
    });
  }

  async delete(automationId: string, pageId: string, workspaceId: string) {
    const current = await this.repo.findById(automationId, workspaceId);
    if (!current || current.pageId !== pageId) throw new NotFoundException('Automation not found');
    await this.repo.delete(automationId);
  }

  async listRuns(automationId: string, pageId: string, workspaceId: string, limit = 30) {
    const current = await this.repo.findById(automationId, workspaceId);
    if (!current || current.pageId !== pageId) throw new NotFoundException('Automation not found');
    return this.repo.listRuns(automationId, Math.min(Math.max(limit, 1), 100));
  }

  // Someone pressed a button (or "Run now").
  async runManually(automationId: string, pageId: string, workspaceId: string, actorId: string, rowId?: string) {
    const automation = await this.repo.findById(automationId, workspaceId);
    if (!automation || automation.pageId !== pageId) throw new NotFoundException('Automation not found');
    if (!automation.enabled) throw new BadRequestException('This automation is turned off');
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    const row = rowId ? await this.baseRowRepo.findById(rowId, { workspaceId }) : undefined;
    if (rowId && (!row || row.pageId !== pageId)) throw new NotFoundException('Row not found');
    if (row && automation.conditions && !matchesFilter(automation.conditions, row, properties)) {
      return { ran: false, reason: 'conditions' as const };
    }
    const made: Array<{ pageId: string; rowId: string }> = [];
    const result = await this.execute(automation, row ?? null, properties, { workspaceId, actorId, depth: 1, made });
    return { ran: true, ...result, createdRows: made };
  }

  // Row events from the services: find the rules that fire and run them.
  async runForEvent(
    kind: 'row.created' | 'row.updated',
    e: { pageId: string; workspaceId: string; actorId?: string | null; rowId: string; patch?: Record<string, unknown>; automationDepth?: number; formId?: string | null },
  ): Promise<void> {
    const depth = e.automationDepth ?? 0;
    if (depth >= MAX_AUTOMATION_DEPTH) return;
    const automations = await this.repo.findEnabledByPage(e.pageId);
    if (automations.length === 0) return;
    const row = await this.baseRowRepo.findById(e.rowId, { workspaceId: e.workspaceId });
    if (!row) return;
    const properties = await this.basePropertyRepo.findByPageId(e.pageId);
    for (const automation of automations) {
      const trigger = automation.trigger as { type: string; propertyId?: string; formId?: string };
      let fires = false;
      if (kind === 'row.created') {
        fires =
          trigger.type === 'row.created' ||
          (trigger.type === 'form.submitted' && Boolean(e.formId) && (!trigger.formId || trigger.formId === e.formId));
      } else {
        fires = trigger.type === 'row.updated' && (!trigger.propertyId || Boolean(e.patch && trigger.propertyId in e.patch));
      }
      if (!fires) continue;
      if (automation.conditions && !matchesFilter(automation.conditions, row, properties)) continue;
      await this.execute(automation, row, properties, { workspaceId: e.workspaceId, actorId: e.actorId ?? null, depth: depth + 1 });
    }
  }

  private async execute(automation: AutomationRow, row: BaseRow | null, properties: BaseProperty[], ctx: RunContext) {
    const actions = automation.actions as AutomationAction[];
    const primary = properties.find((p) => p.isPrimary);
    const title = row && primary ? String(((row.cells ?? {}) as any)[primary.id] ?? '') : '';
    const errors: string[] = [];
    for (const action of actions) {
      try {
        await this.runAction(action, automation, row, properties, { ...ctx, title });
      } catch (err: any) {
        const message = err?.response?.message ?? err?.message ?? String(err);
        errors.push(`${action.type}: ${Array.isArray(message) ? message.join('; ') : message}`);
        this.logger.warn(`automation ${automation.id} action ${action.type} failed: ${message}`);
      }
    }
    await this.repo.recordRun(automation.id, row?.id ?? null, errors.length ? 'error' : 'ok', errors.length ? errors.join(' | ') : null);
    return { ok: errors.length === 0, errors };
  }

  private async runAction(
    action: AutomationAction,
    automation: AutomationRow,
    row: BaseRow | null,
    properties: BaseProperty[],
    ctx: RunContext & { title: string },
  ): Promise<void> {
    const tpl = (value: unknown) =>
      row ? renderTemplate(value, { row, properties, actorId: ctx.actorId, title: ctx.title }) : renderTemplate(value, { row: { cells: {} } as any, properties, actorId: ctx.actorId, title: '' });
    switch (action.type) {
      case 'set_cells': {
        if (!row) throw new Error('needs a row');
        const cells = this.writableCells(tpl(action.cells) as Record<string, unknown>, properties);
        if (Object.keys(cells).length === 0) return;
        await this.baseRowService.update(
          { pageId: row.pageId, rowId: row.id, cells },
          ctx.workspaceId,
          ctx.actorId ?? undefined,
          { automationDepth: ctx.depth },
        );
        return;
      }
      case 'create_row': {
        const targetPageId = action.pageId ?? automation.pageId;
        const targetProps = targetPageId === automation.pageId ? properties : await this.basePropertyRepo.findByPageId(targetPageId);
        const cells = this.writableCells(tpl(action.cells) as Record<string, unknown>, targetProps);
        const created: any = await this.baseRowService.create(ctx.actorId, ctx.workspaceId, { pageId: targetPageId, cells }, { automationDepth: ctx.depth });
        if (created?.id) ctx.made?.push({ pageId: targetPageId, rowId: created.id });
        return;
      }
      case 'notify': {
        const base = await this.baseRepo.findById(automation.pageId);
        if (!base) return;
        const recipients = new Set<string>(action.userIds ?? []);
        if (row && action.personPropertyId) {
          const v = ((row.cells ?? {}) as any)[action.personPropertyId];
          for (const id of Array.isArray(v) ? v : v ? [v] : []) if (typeof id === 'string') recipients.add(id);
        }
        if (row && action.notifyCreator && row.creatorId) recipients.add(row.creatorId);
        const message = String(tpl(action.message));
        for (const userId of recipients) {
          await this.notifications.create({
            userId,
            workspaceId: ctx.workspaceId,
            type: BASE_AUTOMATION_NOTIFICATION,
            actorId: ctx.actorId,
            pageId: automation.pageId,
            spaceId: base.spaceId,
            data: { message, automationName: automation.name, rowId: row?.id ?? null, title: ctx.title },
          } as any);
        }
        return;
      }
      case 'webhook': {
        await this.postWebhook(action.url, action.secret, {
          event: 'base.automation',
          automation: { id: automation.id, name: automation.name },
          base: { id: automation.pageId },
          row: row ? { id: row.id, cells: row.cells, rowNo: row.rowNo } : null,
          actorId: ctx.actorId,
          at: new Date().toISOString(),
        });
        return;
      }
    }
  }

  // Only real, writable cells of this base reach the row service.
  private writableCells(cells: Record<string, unknown>, properties: BaseProperty[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(cells ?? {})) {
      const p = properties.find((x) => x.id === id);
      if (!p || isSystemPropertyType(p.type) || p.type === 'button') continue;
      out[id] = value;
    }
    return out;
  }

  private parseSpec(input: unknown) {
    const parsed = automationSpecSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid automation', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    return parsed.data;
  }

  private async assertActionTargets(actions: AutomationAction[], pageId: string, workspaceId: string) {
    for (const a of actions) {
      if (a.type === 'create_row' && a.pageId && a.pageId !== pageId) {
        const target = await this.baseRepo.findById(a.pageId);
        if (!target || target.workspaceId !== workspaceId) throw new BadRequestException('Target base not found');
      }
      if (a.type === 'webhook') assertPublicUrl(a.url);
    }
  }

  private async postWebhook(url: string, secret: string | undefined, payload: unknown): Promise<void> {
    assertPublicUrl(url);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-docmore-event': 'base.automation' };
    if (secret) headers['x-docmore-signature'] = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
