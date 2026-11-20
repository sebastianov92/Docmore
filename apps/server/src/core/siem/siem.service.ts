import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EncryptionPurpose, EncryptionService } from '../../integrations/encryption/encryption.service';
import { assertPublicUrl } from '../../common/helpers/public-url';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';
import { UserRole } from '../../common/helpers/types/permission';
import { CreateSiemDestinationDto, UpdateSiemDestinationDto } from './siem.dto';

type Destination = {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  config: any;
  secrets: string;
  enabled: boolean;
  status: string;
  cursorCreatedAt: Date;
  cursorId: string;
  consecutiveFailures: number;
  failingSince: Date | null;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  nextAttemptAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

const POLL_EVERY_MS = 60_000;
const BATCH = 200;
const DISABLE_AFTER_MS = 24 * 60 * 60 * 1000;

// Ships the audit trail to a SIEM: each destination keeps a cursor into the
// audit table and gets new rows every minute; failures back off, and a day
// of failures turns the destination off with a word to the owners.
@Injectable()
export class SiemService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SiemService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly encryption: EncryptionService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), POLL_EVERY_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async list(workspaceId: string) {
    const rows = (await this.db.selectFrom('siemDestinations').selectAll().where('workspaceId', '=', workspaceId).orderBy('createdAt', 'asc').execute()) as unknown as Destination[];
    return rows.map((d) => this.toPublic(d));
  }

  async create(workspaceId: string, userId: string, dto: CreateSiemDestinationDto) {
    const config = this.parseConfig(dto.type, dto.config);
    const row = (await this.db
      .insertInto('siemDestinations')
      .values({
        workspaceId,
        name: dto.name.trim(),
        type: dto.type,
        config: config as any,
        secrets: this.encryption.encrypt(JSON.stringify(dto.secrets ?? {}), EncryptionPurpose.SIEM_CREDENTIALS),
        creatorId: userId,
        // start from now: old rows are not replayed
        cursorCreatedAt: new Date(),
        cursorId: '00000000-0000-0000-0000-000000000000',
        status: 'ok',
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as Destination;
    return this.toPublic(row);
  }

  async update(workspaceId: string, dto: UpdateSiemDestinationDto) {
    const current = await this.find(dto.destinationId, workspaceId);
    const config = dto.config ? this.parseConfig(current.type, { ...(current.config ?? {}), ...dto.config }) : undefined;
    const row = (await this.db
      .updateTable('siemDestinations')
      .set({
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(config && { config: config as any }),
        ...(dto.secrets && { secrets: this.encryption.encrypt(JSON.stringify(dto.secrets), EncryptionPurpose.SIEM_CREDENTIALS) }),
        ...(dto.enabled !== undefined && {
          enabled: dto.enabled,
          ...(dto.enabled ? { status: 'ok', consecutiveFailures: 0, failingSince: null, nextAttemptAt: null, lastError: null } : {}),
        }),
        updatedAt: new Date(),
      } as any)
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as Destination;
    return this.toPublic(row);
  }

  async delete(workspaceId: string, destinationId: string) {
    const current = await this.find(destinationId, workspaceId);
    await this.db.deleteFrom('siemDestinations').where('id', '=', current.id).execute();
  }

  // Sends one synthetic event right now.
  async test(workspaceId: string, destinationId: string) {
    const d = await this.find(destinationId, workspaceId);
    await this.send(d, [{ id: 'test', event: 'siem.test', createdAt: new Date().toISOString(), workspaceId, actorType: 'system', metadata: { message: 'Docmore SIEM test' } }]);
    return { ok: true };
  }

  // Delivers whatever is pending for one destination (also used by the poller).
  async runNow(workspaceId: string, destinationId: string) {
    const d = await this.find(destinationId, workspaceId);
    const sent = await this.drain(d);
    return { sent };
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = (await this.db
        .selectFrom('siemDestinations')
        .selectAll()
        .where('enabled', '=', true)
        .where((eb) => eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', new Date())]))
        .execute()) as unknown as Destination[];
      for (const d of due) {
        try {
          await this.drain(d);
        } catch (err: any) {
          this.logger.warn(`SIEM ${d.id} drain failed: ${err?.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async drain(d: Destination): Promise<number> {
    const rows = await this.db
      .selectFrom('audit')
      .selectAll()
      .where('workspaceId', '=', d.workspaceId)
      .where((eb) => eb.or([eb('createdAt', '>', d.cursorCreatedAt), eb.and([eb('createdAt', '=', d.cursorCreatedAt), eb('id', '>', d.cursorId)])]))
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .limit(BATCH)
      .execute();
    if (rows.length === 0) return 0;
    try {
      await this.send(d, rows);
    } catch (err: any) {
      await this.recordFailure(d, err?.message ?? String(err));
      throw err;
    }
    const last = rows[rows.length - 1];
    const wasFailing = d.consecutiveFailures > 0;
    await this.db
      .updateTable('siemDestinations')
      .set({ cursorCreatedAt: last.createdAt as any, cursorId: last.id, lastDeliveredAt: new Date(), consecutiveFailures: 0, failingSince: null, nextAttemptAt: null, lastError: null, status: 'ok', updatedAt: new Date() } as any)
      .where('id', '=', d.id)
      .execute();
    if (wasFailing) await this.notifyOwners(d, NotificationType.SIEM_DESTINATION_RECOVERED);
    return rows.length;
  }

  private async recordFailure(d: Destination, message: string) {
    const failures = d.consecutiveFailures + 1;
    const failingSince = d.failingSince ?? new Date();
    const disable = Date.now() - failingSince.getTime() > DISABLE_AFTER_MS;
    const backoffMin = Math.min(60, Math.pow(2, Math.min(failures, 6)));
    await this.db
      .updateTable('siemDestinations')
      .set({
        consecutiveFailures: failures,
        failingSince,
        lastError: message.slice(0, 500),
        lastErrorAt: new Date(),
        nextAttemptAt: new Date(Date.now() + backoffMin * 60_000),
        status: disable ? 'disabled' : 'failing',
        ...(disable ? { enabled: false } : {}),
        updatedAt: new Date(),
      } as any)
      .where('id', '=', d.id)
      .execute();
    if (failures === 1) await this.notifyOwners(d, NotificationType.SIEM_DESTINATION_FAILING);
    if (disable) await this.notifyOwners(d, NotificationType.SIEM_DESTINATION_DISABLED);
  }

  private async notifyOwners(d: Destination, type: string) {
    const owners = await this.db.selectFrom('users').select(['id']).where('workspaceId', '=', d.workspaceId).where('role', '=', UserRole.OWNER).where('deletedAt', 'is', null).execute();
    for (const o of owners) {
      await this.notifications.create({ userId: o.id, workspaceId: d.workspaceId, type, actorId: null, pageId: null, spaceId: null, data: { name: d.name, destinationId: d.id, error: d.lastError } } as any).catch(() => undefined);
    }
  }

  private async send(d: Destination, rows: unknown[]) {
    const secrets = JSON.parse(this.encryption.decrypt(d.secrets, EncryptionPurpose.SIEM_CREDENTIALS) || '{}') as { token?: string };
    const url = assertPublicUrl(String(d.config?.url ?? '')).toString().replace(/\/+$/, '');
    let endpoint = url;
    let body: string;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Docmore-SIEM/1.0' };
    if (d.type === 'splunk') {
      endpoint = `${url}/services/collector/event`;
      headers.authorization = `Splunk ${secrets.token ?? ''}`;
      body = rows.map((r: any) => JSON.stringify({ time: Math.floor(new Date(r.createdAt).getTime() / 1000), sourcetype: 'docmore:audit', event: r })).join('\n');
    } else if (d.type === 'elastic') {
      const index = String(d.config?.index ?? 'docmore-audit');
      endpoint = `${url}/_bulk`;
      headers['content-type'] = 'application/x-ndjson';
      if (secrets.token) headers.authorization = `ApiKey ${secrets.token}`;
      body = rows.map((r: any) => JSON.stringify({ index: { _index: index, _id: r.id } }) + '\n' + JSON.stringify({ ...r, '@timestamp': r.createdAt })).join('\n') + '\n';
    } else {
      if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
      body = JSON.stringify({ source: 'docmore', events: rows });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
      if (!res.ok) throw new Error(`${d.type} answered ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseConfig(type: string, config: Record<string, unknown>) {
    const url = typeof config?.url === 'string' ? config.url.trim() : '';
    if (!url) throw new BadRequestException('A URL is required');
    assertPublicUrl(url);
    const out: Record<string, unknown> = { url };
    if (type === 'elastic') out.index = String(config?.index ?? 'docmore-audit').trim() || 'docmore-audit';
    return out;
  }

  private async find(id: string, workspaceId: string): Promise<Destination> {
    const row = (await this.db.selectFrom('siemDestinations').selectAll().where('id', '=', id).where('workspaceId', '=', workspaceId).executeTakeFirst()) as unknown as Destination | undefined;
    if (!row) throw new NotFoundException('Destination not found');
    return row;
  }

  private toPublic(d: Destination) {
    const { secrets: _s, ...rest } = d;
    return { ...rest, hasToken: Boolean(safeParse(this.encryption, d.secrets)?.token) };
  }
}

function safeParse(enc: EncryptionService, encrypted: string): { token?: string } | null {
  try {
    return JSON.parse(enc.decrypt(encrypted, EncryptionPurpose.SIEM_CREDENTIALS) || '{}');
  } catch {
    return null;
  }
}

export { sql as _siemSql };
