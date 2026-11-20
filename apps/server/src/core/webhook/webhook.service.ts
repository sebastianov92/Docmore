import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { EncryptionPurpose, EncryptionService } from '../../integrations/encryption/encryption.service';
import { assertPublicUrl } from '../../common/helpers/public-url';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';
import { MAX_WEBHOOK_PAYLOAD_BYTES, WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_EVENTS } from './webhook.constants';

export type WebhookRow = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  failures: number;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  creatorId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WebhookJob = {
  webhookId: string;
  deliveryId: string;
  event: string;
  workspaceId: string;
  createdAt: string;
  data: unknown;
};

// Outgoing webhooks: subscriptions, the queue that delivers them with a
// signed body, and the log of what each delivery did.
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.WEBHOOK_QUEUE) private readonly queue: Queue,
    private readonly encryption: EncryptionService,
  ) {}

  async list(workspaceId: string) {
    const rows = (await this.db.selectFrom('webhooks').selectAll().where('workspaceId', '=', workspaceId).orderBy('createdAt', 'asc').execute()) as unknown as WebhookRow[];
    return rows.map((w) => this.toPublic(w));
  }

  async create(workspaceId: string, userId: string, dto: CreateWebhookDto) {
    assertPublicUrl(dto.url);
    const events = this.parseEvents(dto.events);
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const row = (await this.db
      .insertInto('webhooks')
      .values({
        workspaceId,
        name: dto.name.trim(),
        url: dto.url.trim(),
        secret: this.encryption.encrypt(secret, EncryptionPurpose.WEBHOOK_SECRETS),
        events: events as any,
        creatorId: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as WebhookRow;
    // the secret is shown once
    return { ...this.toPublic(row), secret };
  }

  async update(workspaceId: string, dto: UpdateWebhookDto) {
    const current = await this.find(dto.webhookId, workspaceId);
    if (dto.url !== undefined) assertPublicUrl(dto.url);
    const events = dto.events !== undefined ? this.parseEvents(dto.events) : undefined;
    const secret = dto.rotateSecret ? `whsec_${randomBytes(24).toString('hex')}` : undefined;
    const row = (await this.db
      .updateTable('webhooks')
      .set({
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.url !== undefined && { url: dto.url.trim() }),
        ...(events !== undefined && { events: events as any }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled, ...(dto.enabled ? { failures: 0, lastError: null } : {}) }),
        ...(secret && { secret: this.encryption.encrypt(secret, EncryptionPurpose.WEBHOOK_SECRETS) }),
        updatedAt: new Date(),
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as WebhookRow;
    return { ...this.toPublic(row), ...(secret ? { secret } : {}) };
  }

  async delete(workspaceId: string, webhookId: string) {
    const current = await this.find(webhookId, workspaceId);
    await this.db.deleteFrom('webhooks').where('id', '=', current.id).execute();
  }

  async deliveries(workspaceId: string, webhookId: string) {
    const current = await this.find(webhookId, workspaceId);
    return this.db.selectFrom('webhookDeliveries').selectAll().where('webhookId', '=', current.id).orderBy('createdAt', 'desc').limit(50).execute();
  }

  async test(workspaceId: string, webhookId: string) {
    const current = await this.find(webhookId, workspaceId);
    await this.enqueue(current, 'webhook.test', { message: 'This is a test delivery from Docmore.' });
    return { queued: true };
  }

  // Called by the listener for every domain event; fans out to subscribers.
  async dispatch(event: string, workspaceId: string, data: unknown): Promise<void> {
    const hooks = (await this.db
      .selectFrom('webhooks')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', true)
      .execute()) as unknown as WebhookRow[];
    const wanted = hooks.filter((h) => (h.events as string[]).includes('*') || (h.events as string[]).includes(event));
    if (wanted.length === 0) return;
    const payload = sanitize(data);
    for (const hook of wanted) await this.enqueue(hook, event, payload);
  }

  private async enqueue(hook: WebhookRow, event: string, data: unknown) {
    const delivery = await this.db
      .insertInto('webhookDeliveries')
      .values({ webhookId: hook.id, event, ok: false })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    const job: WebhookJob = { webhookId: hook.id, deliveryId: delivery.id, event, workspaceId: hook.workspaceId, createdAt: new Date().toISOString(), data };
    await this.queue.add(QueueJob.WEBHOOK_DELIVER, job, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    });
  }

  // Runs on the queue: one signed POST; the delivery row records the outcome.
  async deliver(job: WebhookJob, attempt: number): Promise<void> {
    const hook = (await this.db.selectFrom('webhooks').selectAll().where('id', '=', job.webhookId).executeTakeFirst()) as unknown as WebhookRow | undefined;
    if (!hook || !hook.enabled) return;
    const body = JSON.stringify({ id: job.deliveryId, event: job.event, createdAt: job.createdAt, workspaceId: job.workspaceId, data: job.data });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = this.encryption.decrypt(hook.secret, EncryptionPurpose.WEBHOOK_SECRETS);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      assertPublicUrl(hook.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Docmore-Webhooks/1.0',
            'x-docmore-event': job.event,
            'x-docmore-delivery': job.deliveryId,
            'x-docmore-timestamp': timestamp,
            'x-docmore-signature': `v1=${signature}`,
          },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
        status = res.status;
        if (!res.ok) error = `answered ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      error = err?.name === 'AbortError' ? 'timed out after 10s' : (err?.message ?? String(err));
    }
    const ok = error === null;
    await this.db
      .updateTable('webhookDeliveries')
      .set({ status, ok, error, durationMs: Date.now() - started, attempt })
      .where('id', '=', job.deliveryId)
      .execute();
    await sql`delete from webhook_deliveries where webhook_id = ${hook.id} and id not in (select id from webhook_deliveries where webhook_id = ${hook.id} order by created_at desc limit 50)`.execute(this.db);
    if (ok) {
      await this.db.updateTable('webhooks').set({ failures: 0, lastError: null, lastDeliveredAt: new Date() }).where('id', '=', hook.id).execute();
      return;
    }
    const failures = hook.failures + 1;
    const disable = failures >= WEBHOOK_DISABLE_AFTER_FAILURES;
    await this.db
      .updateTable('webhooks')
      .set({ failures, lastError: error, ...(disable ? { enabled: false } : {}), updatedAt: new Date() })
      .where('id', '=', hook.id)
      .execute();
    if (disable) this.logger.warn(`webhook ${hook.id} disabled after ${failures} failures`);
    // let the queue retry
    throw new Error(error ?? 'delivery failed');
  }

  private async find(webhookId: string, workspaceId: string): Promise<WebhookRow> {
    const row = (await this.db.selectFrom('webhooks').selectAll().where('id', '=', webhookId).where('workspaceId', '=', workspaceId).executeTakeFirst()) as unknown as WebhookRow | undefined;
    if (!row) throw new NotFoundException('Webhook not found');
    return row;
  }

  private parseEvents(events: string[] | undefined): string[] {
    if (!events || events.length === 0) return ['*'];
    const allowed = new Set<string>([...WEBHOOK_EVENTS, '*']);
    const bad = events.filter((e) => !allowed.has(e));
    if (bad.length) throw new BadRequestException(`Unknown events: ${bad.join(', ')}`);
    return [...new Set(events)];
  }

  private toPublic(w: WebhookRow) {
    const { secret: _secret, ...rest } = w;
    return rest;
  }
}

// Strips document bodies and anything secret-looking, then caps the size.
function sanitize(value: unknown, depth = 0): unknown {
  const DROP = new Set(['content', 'ydoc', 'textContent', 'password', 'token', 'secret', 'accessToken', 'refreshToken']);
  const walk = (v: unknown, d: number): unknown => {
    if (d > 6) return undefined;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, d + 1));
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (DROP.has(k) || typeof x === 'function' || k === 'trx') continue;
        const w = walk(x, d + 1);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return v;
  };
  let out = walk(value, depth);
  const json = JSON.stringify(out ?? null);
  if (json.length > MAX_WEBHOOK_PAYLOAD_BYTES) out = { truncated: true, preview: json.slice(0, 2000) };
  return out;
}
