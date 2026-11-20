import { parseLocationText } from '../base.schemas';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectKysely } from 'nestjs-kysely';
import { Queue } from 'bullmq';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { BaseProperty, Page, User } from '@docmost/db/types/entity.types';
import { BasePropertyRepo } from '@docmost/db/repos/base/base-property.repo';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { StorageService } from '../../../integrations/storage/storage.service';
import {
  FileTaskStatus,
  FileTaskType,
  getFileTaskFolderPath,
} from '../../../integrations/import/utils/file.utils';
import {
  QueueJob,
  QueueName,
} from '../../../integrations/queue/constants/queue.constants';
import { IBaseCsvImportJob } from '../../../integrations/queue/constants/queue.interface';
import { EventName } from '../../../common/events/event.contants';
import {
  AuditEvent,
  AuditResource,
} from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { generateBaseChoiceId } from '../../../common/helpers/nanoid.utils';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { BasePropertyService } from '../services/base-property.service';
import { FormulaService } from '../formula/formula.service';
import { BasePropertyType, validateCellValue } from '../base.schemas';
import {
  CSV_IMPORT_LIMITS,
  CsvImportColumn,
  CsvImportSpec,
  csvImportSpecSchema,
} from './base-csv-import.schema';
import { sql } from 'kysely';

export const BASE_CSV_IMPORT_SOURCE = 'base-csv';

const CHOICE_COLORS = [
  'gray',
  'red',
  'pink',
  'grape',
  'violet',
  'indigo',
  'blue',
  'cyan',
  'teal',
  'green',
  'lime',
  'yellow',
  'orange',
];

type Choice = {
  id: string;
  name: string;
  color: string;
  category?: 'todo' | 'inProgress' | 'complete';
};

type ColumnTarget = {
  property: BaseProperty;
  // Choice properties collect new options here and flush them once.
  choicesByName?: Map<string, Choice>;
  newChoices?: Choice[];
};

type UploadedFile = {
  filename: string;
  toBuffer: () => Promise<Buffer>;
};

// CSV import: the client parses the file in the browser and uploads one JSON
// array per row (JSONL) plus a spec that maps columns to properties. The
// upload only stores the file and queues the job; the job creates missing
// properties and options, resolves people, validates every cell and inserts
// rows in batches while reporting progress over the base's socket room.
@Injectable()
export class BaseCsvImportService {
  private readonly logger = new Logger(BaseCsvImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.BASE_IMPORT_QUEUE) private readonly importQueue: Queue,
    private readonly storageService: StorageService,
    private readonly baseRepo: BaseRepo,
    private readonly basePropertyRepo: BasePropertyRepo,
    private readonly basePropertyService: BasePropertyService,
    private readonly formulaService: FormulaService,
    private readonly notificationService: NotificationService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  parseSpec(raw: unknown): CsvImportSpec {
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new BadRequestException('spec must be JSON');
      }
    }
    const result = csvImportSpecSchema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid import spec',
        errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return result.data;
  }

  async start(page: Page, user: User, spec: CsvImportSpec, file: UploadedFile) {
    const properties = await this.basePropertyRepo.findByPageId(page.id);
    this.checkColumns(spec, properties);

    const buffer = await file.toBuffer();
    if (buffer.length > CSV_IMPORT_LIMITS.maxFileBytes) {
      throw new BadRequestException('Import file is too large');
    }

    const task = await this.db
      .insertInto('fileTasks')
      .values({
        type: FileTaskType.Import,
        source: BASE_CSV_IMPORT_SOURCE,
        status: FileTaskStatus.Processing,
        fileName: spec.fileName,
        filePath: '',
        fileExt: 'jsonl',
        fileSize: buffer.length,
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        creatorId: user.id,
        metadata: {
          spec,
          totalRows: spec.rowCount,
          processedRows: 0,
          importedRows: 0,
          skippedValues: spec.skippedValues ?? 0,
        } as any,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const filePath = `${getFileTaskFolderPath(FileTaskType.Import, page.workspaceId)}/${task.id}.jsonl`;
    await this.storageService.upload(filePath, buffer);
    await this.db
      .updateTable('fileTasks')
      .set({ filePath })
      .where('id', '=', task.id)
      .execute();

    const payload: IBaseCsvImportJob = { fileTaskId: task.id };
    await this.importQueue.add(QueueJob.BASE_CSV_IMPORT, payload, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    return { ...task, filePath };
  }

  // Runs in the worker.
  async run(fileTaskId: string): Promise<void> {
    const task = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .executeTakeFirst();
    if (!task || !task.pageId) {
      this.logger.warn(`csv import ${fileTaskId}: task not found`);
      return;
    }
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const spec = this.parseSpec(meta.spec);
    const pageId = task.pageId;
    const workspaceId = task.workspaceId;
    const actorId = task.creatorId ?? null;

    let importedRows = 0;
    let skippedValues = Number(spec.skippedValues ?? 0);
    try {
      const base = await this.baseRepo.findById(pageId);
      if (!base) throw new Error('Base not found');

      const raw = await this.storageService.read(task.filePath);
      const lines = raw
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const totalRows = Math.min(lines.length, CSV_IMPORT_LIMITS.maxRows);

      const targets = await this.resolveTargets(pageId, workspaceId, spec, actorId);
      const people = await this.loadPeople(workspaceId);

      let lastPosition = await this.lastRowPosition(pageId);
      let batch: Array<Record<string, unknown>> = [];
      let processedRows = 0;

      const flush = async () => {
        if (batch.length === 0) return;
        const rows = batch;
        await this.db.transaction().execute(async (trx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${pageId}))`.execute(trx);
          const m = await trx
            .selectFrom('baseRows')
            .select(sql<number>`coalesce(max(row_no), 0)`.as('m'))
            .where('pageId', '=', pageId)
            .executeTakeFirst();
          const start = Number(m?.m ?? 0) + 1;
          await trx
            .insertInto('baseRows')
            .values(rows.map((r, i) => ({ ...r, rowNo: start + i })) as any)
            .execute();
        });
        importedRows += batch.length;
        batch = [];
        await this.db
          .updateTable('fileTasks')
          .set({
            metadata: { ...meta, totalRows, processedRows, importedRows, skippedValues } as any,
            updatedAt: new Date(),
          })
          .where('id', '=', task.id)
          .execute();
        this.eventEmitter.emit(EventName.BASE_IMPORT_PROGRESS, {
          pageId,
          workspaceId,
          actorId,
          fileTaskId: task.id,
          processedRows,
          totalRows,
        });
      };

      for (const line of lines.slice(0, totalRows)) {
        processedRows++;
        let values: unknown[];
        try {
          const parsed = JSON.parse(line);
          values = Array.isArray(parsed) ? parsed : [];
        } catch {
          skippedValues++;
          continue;
        }
        const cells: Record<string, unknown> = {};
        targets.forEach((target, index) => {
          const converted = this.convertValue(target, values[index], people);
          if (converted.skipped) skippedValues++;
          if (converted.value !== null && converted.value !== undefined) {
            cells[target.property.id] = converted.value;
          }
        });
        if (Object.keys(cells).length === 0) continue;
        lastPosition = generateJitteredKeyBetween(lastPosition, null);
        batch.push({
          pageId,
          workspaceId,
          cells,
          position: lastPosition,
          creatorId: actorId,
          lastUpdatedById: actorId,
        });
        if (batch.length >= CSV_IMPORT_LIMITS.batchSize) await flush();
      }
      await flush();

      await this.flushChoices(targets, workspaceId, actorId);

      const formulaIds = (await this.basePropertyRepo.findByPageId(pageId))
        .filter((p) => p.type === BasePropertyType.FORMULA)
        .map((p) => p.id);
      if (formulaIds.length > 0 && importedRows > 0) {
        await this.formulaService.enqueueRecompute({
          pageId,
          workspaceId,
          propertyIds: formulaIds,
          reason: 'bulk_import',
          actorId,
        });
      }

      await this.finish(task.id, pageId, workspaceId, actorId, {
        status: 'success',
        totalRows,
        importedRows,
        skippedValues,
        fileName: spec.fileName,
        spaceId: task.spaceId,
      });
    } catch (err: any) {
      this.logger.error(`csv import ${fileTaskId} failed: ${err?.message}`);
      await this.finish(task.id, pageId, workspaceId, actorId, {
        status: 'failed',
        totalRows: spec.rowCount,
        importedRows,
        skippedValues,
        fileName: spec.fileName,
        spaceId: task.spaceId,
        error: err?.message ?? 'Import failed',
      });
    } finally {
      try {
        await this.storageService.delete(task.filePath);
      } catch {
        // the file is only an intermediate
      }
    }
  }

  // ---- helpers --------------------------------------------------------------

  private checkColumns(spec: CsvImportSpec, properties: BaseProperty[]) {
    const byId = new Map(properties.map((p) => [p.id, p]));
    const takenNames = new Set(
      properties.map((p) => p.name.trim().toLowerCase()),
    );
    const newNames = new Set<string>();
    for (const column of spec.columns) {
      if ('propertyId' in column) {
        const property = byId.get(column.propertyId);
        if (!property) {
          throw new BadRequestException(`Unknown property ${column.propertyId}`);
        }
        if (
          property.type === BasePropertyType.FORMULA ||
          property.type === BasePropertyType.CREATED_AT ||
          property.type === BasePropertyType.LAST_EDITED_AT ||
          property.type === BasePropertyType.LAST_EDITED_BY ||
          property.type === BasePropertyType.FILE ||
          property.type === BasePropertyType.PAGE
        ) {
          throw new BadRequestException(
            `Property "${property.name}" cannot be filled from a CSV`,
          );
        }
      } else {
        const key = column.name.trim().toLowerCase();
        if (takenNames.has(key) || newNames.has(key)) {
          throw new BadRequestException(
            `A property named "${column.name}" already exists`,
          );
        }
        newNames.add(key);
      }
    }
  }

  private async resolveTargets(
    pageId: string,
    workspaceId: string,
    spec: CsvImportSpec,
    actorId: string | null,
  ): Promise<ColumnTarget[]> {
    const properties = await this.basePropertyRepo.findByPageId(pageId);
    const byId = new Map(properties.map((p) => [p.id, p]));
    const targets: ColumnTarget[] = [];
    for (const column of spec.columns) {
      let property: BaseProperty | undefined;
      if ('propertyId' in column) {
        property = byId.get(column.propertyId);
      } else {
        property = await this.basePropertyService.create(
          workspaceId,
          {
            pageId,
            name: column.name,
            type: column.type,
            typeOptions: this.defaultTypeOptions(column),
          },
          actorId ?? undefined,
        );
      }
      if (!property) throw new Error('Property vanished during import');
      const target: ColumnTarget = { property };
      if (isChoiceType(property.type)) {
        const options = (property.typeOptions ?? {}) as { choices?: Choice[] };
        target.choicesByName = new Map(
          (options.choices ?? []).map((c) => [c.name.trim().toLowerCase(), c]),
        );
        target.newChoices = [];
      }
      targets.push(target);
    }
    return targets;
  }

  private defaultTypeOptions(column: CsvImportColumn): Record<string, unknown> {
    if ('propertyId' in column) return {};
    const given = column.typeOptions ?? {};
    if (isChoiceType(column.type)) {
      return { choices: [], choiceOrder: [], ...given };
    }
    if (column.type === 'number') return { format: 'plain', ...given };
    return given;
  }

  private async loadPeople(workspaceId: string) {
    const users = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'name'])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    const byToken = new Map<string, string>();
    for (const user of users) {
      if (user.email) byToken.set(user.email.trim().toLowerCase(), user.id);
      if (user.name) byToken.set(user.name.trim().toLowerCase(), user.id);
    }
    return byToken;
  }

  private async lastRowPosition(pageId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('baseRows')
      .select('position')
      .where('pageId', '=', pageId)
      .where('deletedAt', 'is', null)
      .orderBy('position', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.position ?? null;
  }

  // Turns one CSV value into a cell value for its property, or skips it.
  private convertValue(
    target: ColumnTarget,
    raw: unknown,
    people: Map<string, string>,
  ): { value: unknown; skipped: boolean } {
    if (raw === null || raw === undefined || raw === '') {
      return { value: null, skipped: false };
    }
    const { property } = target;
    const type = property.type;
    let value: unknown = raw;

    if (isChoiceType(type)) {
      const names = Array.isArray(raw) ? raw : [raw];
      const ids: string[] = [];
      for (const name of names) {
        const text = String(name).trim();
        if (!text) continue;
        const id = this.choiceId(target, text);
        if (id) ids.push(id);
      }
      if (ids.length === 0) return { value: null, skipped: true };
      value = type === BasePropertyType.MULTI_SELECT ? ids : ids[0];
    } else if (type === BasePropertyType.PERSON) {
      const tokens = Array.isArray(raw) ? raw : [raw];
      const ids = tokens
        .map((t) => people.get(String(t).trim().toLowerCase()))
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) return { value: null, skipped: true };
      const allowMultiple = Boolean(
        (property.typeOptions as { allowMultiple?: boolean } | null)?.allowMultiple,
      );
      value = allowMultiple ? [...new Set(ids)] : ids[0];
    } else if (type === BasePropertyType.NUMBER) {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { value: null, skipped: true };
      value = n;
    } else if (type === BasePropertyType.CHECKBOX) {
      if (typeof raw === 'boolean') value = raw;
      else {
        const text = String(raw).trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'on', 'x'].includes(text)) value = true;
        else if (['false', 'no', 'n', '0', 'off', ''].includes(text)) value = false;
        else return { value: null, skipped: true };
      }
    } else if (type === BasePropertyType.DATE) {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) return { value: null, skipped: true };
      value = date.toISOString();
    } else if (type === BasePropertyType.LOCATION) {
      const parsed = parseLocationText(String(raw));
      if (!parsed) return { value: null, skipped: true };
      value = parsed;
    } else {
      value = String(raw);
      if (type === BasePropertyType.TEXT) value = (value as string).slice(0, 1000);
      if (type === BasePropertyType.LONG_TEXT) value = (value as string).slice(0, 25_000);
    }

    const result = validateCellValue(type as any, value);
    if (!result.success) return { value: null, skipped: true };
    return { value: result.data, skipped: false };
  }

  private choiceId(target: ColumnTarget, name: string): string | null {
    const key = name.toLowerCase();
    const existing = target.choicesByName!.get(key);
    if (existing) return existing.id;
    const total = target.choicesByName!.size;
    if (total >= CSV_IMPORT_LIMITS.maxChoices) return null;
    const choice: Choice = {
      id: generateBaseChoiceId(),
      name: name.slice(0, CSV_IMPORT_LIMITS.maxNameLength),
      color: CHOICE_COLORS[total % CHOICE_COLORS.length],
    };
    if (target.property.type === BasePropertyType.STATUS) {
      choice.category = guessStatusCategory(name);
      choice.color =
        choice.category === 'complete'
          ? 'green'
          : choice.category === 'inProgress'
            ? 'blue'
            : 'gray';
    }
    target.choicesByName!.set(key, choice);
    target.newChoices!.push(choice);
    return choice.id;
  }

  // Options created while converting are written to the property once.
  private async flushChoices(
    targets: ColumnTarget[],
    workspaceId: string,
    actorId: string | null,
  ) {
    for (const target of targets) {
      if (!target.newChoices || target.newChoices.length === 0) continue;
      const current = (target.property.typeOptions ?? {}) as {
        choices?: Choice[];
        choiceOrder?: string[];
      };
      const choices = [...(current.choices ?? []), ...target.newChoices];
      const choiceOrder = [
        ...(current.choiceOrder ?? []),
        ...target.newChoices.map((c) => c.id),
      ];
      await this.basePropertyService.update(
        {
          pageId: target.property.pageId,
          propertyId: target.property.id,
          typeOptions: { ...current, choices, choiceOrder },
        } as any,
        workspaceId,
        actorId ?? undefined,
      );
    }
  }

  private async finish(
    fileTaskId: string,
    pageId: string,
    workspaceId: string,
    actorId: string | null,
    result: {
      status: 'success' | 'failed';
      totalRows: number;
      importedRows: number;
      skippedValues: number;
      fileName: string;
      spaceId: string | null;
      error?: string;
    },
  ) {
    const current = await this.db
      .selectFrom('fileTasks')
      .select('metadata')
      .where('id', '=', fileTaskId)
      .executeTakeFirst();
    const meta = (current?.metadata ?? {}) as Record<string, unknown>;
    await this.db
      .updateTable('fileTasks')
      .set({
        status: result.status === 'success' ? FileTaskStatus.Success : FileTaskStatus.Failed,
        errorMessage: result.error ?? null,
        metadata: {
          ...meta,
          totalRows: result.totalRows,
          processedRows: result.totalRows,
          importedRows: result.importedRows,
          skippedValues: result.skippedValues,
        } as any,
        updatedAt: new Date(),
      })
      .where('id', '=', fileTaskId)
      .execute();

    this.eventEmitter.emit(EventName.BASE_IMPORT_COMPLETED, {
      pageId,
      workspaceId,
      actorId,
      fileTaskId,
      status: result.status,
      totalRows: result.totalRows,
      importedRows: result.importedRows,
      skippedValues: result.skippedValues,
      error: result.error ?? null,
    });

    if (actorId) {
      try {
        await this.notificationService.create({
          userId: actorId,
          workspaceId,
          type:
            result.status === 'success'
              ? NotificationType.BASE_IMPORT_COMPLETED
              : NotificationType.BASE_IMPORT_FAILED,
          pageId,
          spaceId: result.spaceId,
          data: {
            fileName: result.fileName,
            importedRows: result.importedRows,
            skippedValues: result.skippedValues,
            error: result.error ?? null,
          },
        } as any);
      } catch (err: any) {
        this.logger.warn(`csv import notification failed: ${err?.message}`);
      }
      void Promise.resolve(
        this.auditService.logWithContext(
          {
            event: AuditEvent.BASE_IMPORTED,
            resourceType: AuditResource.BASE,
            resourceId: pageId,
            spaceId: result.spaceId ?? undefined,
            metadata: {
              fileName: result.fileName,
              importedRows: result.importedRows,
              skippedValues: result.skippedValues,
              status: result.status,
            },
          },
          { workspaceId, actorId },
        ),
      ).catch(() => undefined);
    }
  }
}

function isChoiceType(type: string): boolean {
  return (
    type === BasePropertyType.SELECT ||
    type === BasePropertyType.STATUS ||
    type === BasePropertyType.MULTI_SELECT
  );
}

function guessStatusCategory(name: string): 'todo' | 'inProgress' | 'complete' {
  const text = name.toLowerCase();
  if (/done|complete|closed|finished|resolved|shipped|released/.test(text)) {
    return 'complete';
  }
  if (/progress|doing|active|started|review|testing|ongoing/.test(text)) {
    return 'inProgress';
  }
  return 'todo';
}
