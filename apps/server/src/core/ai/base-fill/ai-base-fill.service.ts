import { parseConnectedText, parseLocationText } from '../../base/base.schemas';
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRowRepo } from '@docmost/db/repos/base/base-row.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { BaseProperty, BaseRow } from '@docmost/db/types/entity.types';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { AiGenerateService } from '../ai-generate.service';
import { AiUsageService } from '../ai-usage.service';
import { BaseRowService } from '../../base/services/base-row.service';

export type AiFillJob = {
  pageId: string;
  propertyId: string;
  workspaceId: string;
  userId: string | null;
  rowIds?: string[];
  onlyEmpty?: boolean;
};

const MAX_ROWS_PER_JOB = 200;

// Fills a property with the answer to a prompt over each row's other
// cells; runs on the AI queue, counts against the person's daily limit.
@Injectable()
export class AiBaseFillService {
  private readonly logger = new Logger(AiBaseFillService.name);

  constructor(
    @InjectQueue(QueueName.AI_QUEUE) private readonly queue: Queue,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly generate: AiGenerateService,
    private readonly usage: AiUsageService,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly baseRowRepo: BaseRowRepo,
    private readonly baseRowService: BaseRowService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
  ) {}

  async enqueue(job: AiFillJob, opts: { delayMs?: number } = {}): Promise<void> {
    const single = job.rowIds?.length === 1 ? job.rowIds[0] : null;
    await this.queue.add(QueueJob.BASE_AI_FILL, job, {
      ...(single ? { jobId: `ai-fill:${single}:${job.propertyId}` } : {}),
      delay: opts.delayMs ?? 0,
      removeOnComplete: true,
      removeOnFail: 20,
      attempts: 1,
    });
  }

  async process(job: AiFillJob): Promise<void> {
    const property = await this.basePropertyRepo.findById(job.propertyId);
    if (!property || property.pageId !== job.pageId) return;
    const ai = ((property.typeOptions ?? {}) as any).ai as { prompt?: string; sourcePropertyIds?: string[] } | undefined;
    if (!ai?.prompt) return;
    const properties = await this.basePropertyRepo.findByPageId(job.pageId);
    const rows = job.rowIds
      ? await this.baseRowRepo.findByIds(job.rowIds, { workspaceId: job.workspaceId })
      : await this.emptyRows(job.pageId, job.workspaceId, job.propertyId, job.onlyEmpty !== false);
    if (rows.length === 0) return;
    const workspace = await this.workspaceRepo.findById(job.workspaceId);
    const user = job.userId ? await this.userRepo.findById(job.userId, job.workspaceId) : null;
    if (!workspace) return;
    for (const row of rows) {
      if (user) await this.usage.assertAllowed(workspace, user); // throws over the limit; the job stops
      const content = describeRow(row, properties, property.id, ai.sourcePropertyIds);
      if (!content.trim()) continue;
      let text: string;
      try {
        text = await this.generate.complete(job.workspaceId, { action: 'custom', content, prompt: ai.prompt });
      } catch (err: any) {
        this.logger.warn(`AI fill failed for row ${row.id}: ${err?.message}`);
        continue;
      }
      const value = coerce(text, property);
      if (value === undefined) continue;
      await this.baseRowService.update(
        { pageId: job.pageId, rowId: row.id, cells: { [property.id]: value } },
        job.workspaceId,
        job.userId ?? undefined,
        { automationDepth: 1 },
      );
    }
  }

  private async emptyRows(pageId: string, workspaceId: string, propertyId: string, onlyEmpty: boolean): Promise<BaseRow[]> {
    let q = this.db
      .selectFrom('baseRows')
      .selectAll()
      .where('pageId', '=', pageId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('isTemplate', '=', false)
      .orderBy('position', 'asc')
      .limit(MAX_ROWS_PER_JOB);
    if (onlyEmpty) q = q.where(sql<boolean>`coalesce(cells->>${propertyId}, '') = ''`);
    return (await q.execute()) as unknown as BaseRow[];
  }
}

// "Name: value" lines of the row, without the target column (and only
// the chosen sources when given).
export function describeRow(row: BaseRow, properties: BaseProperty[], targetId: string, sourceIds?: string[]): string {
  const cells = (row.cells ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const p of properties) {
    if (p.id === targetId) continue;
    if (sourceIds?.length && !sourceIds.includes(p.id)) continue;
    if (p.type === 'button' || p.type === 'file' || p.type === 'relation' || p.type === 'rollup' || p.type === 'person' || p.type === 'lastEditedBy') continue;
    let v = cells[p.id];
    if (v === null || v === undefined || v === '') continue;
    if (p.type === 'select' || p.type === 'status' || p.type === 'multiSelect') {
      const choices = (((p.typeOptions ?? {}) as any).choices ?? []) as Array<{ id: string; name: string }>;
      const ids = Array.isArray(v) ? v : [v];
      v = ids.map((id) => choices.find((c) => c.id === id)?.name ?? '').filter(Boolean).join(', ');
    }
    if (Array.isArray(v)) v = v.join(', ');
    lines.push(`${p.name}: ${String(v).slice(0, 2000)}`);
  }
  return lines.join('\n');
}

// Turns the model's text into a value of the property's type; undefined
// when it does not fit.
export function coerce(text: string, property: BaseProperty): unknown {
  const t = text.trim().replace(/^["'`]+|["'`]+$/g, '');
  switch (property.type) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
      return t.slice(0, property.type === 'longText' ? 25_000 : 2_000);
    case 'location':
      return parseLocationText(t) ?? undefined;
    case 'connected':
      return parseConnectedText(t) ?? undefined;
    case 'number': {
      const n = Number(t.replace(/[^\d.,-]/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return /^(yes|true|sí|si|1|y)\b/i.test(t) ? true : /^(no|false|0|n)\b/i.test(t) ? false : undefined;
    case 'select':
    case 'status':
    case 'multiSelect': {
      const choices = (((property.typeOptions ?? {}) as any).choices ?? []) as Array<{ id: string; name: string }>;
      const wanted = t.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const ids = wanted
        .map((w) => choices.find((c) => c.name.toLowerCase() === w) ?? choices.find((c) => w.includes(c.name.toLowerCase())))
        .filter((c): c is { id: string; name: string } => Boolean(c))
        .map((c) => c.id);
      if (ids.length === 0) return undefined;
      return property.type === 'multiSelect' ? [...new Set(ids)] : ids[0];
    }
    default:
      return undefined;
  }
}
