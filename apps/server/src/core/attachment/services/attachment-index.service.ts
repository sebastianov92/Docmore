import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { StorageService } from '../../../integrations/storage/storage.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { AttachmentType } from '../attachment.constants';
import {
  decodePlainText,
  isIndexableExtension,
  isPlainTextExtension,
  MAX_INDEXABLE_FILE_BYTES,
  MAX_INDEXED_TEXT_CHARS,
  normalizeExtension,
  normalizeExtractedText,
} from '../attachment-index.utils';

const BACKFILL_BATCH = 200;

export interface AttachmentIndexingJob {
  workspaceId: string;
  // Re-index files that already carry text, e.g. after an extractor fix.
  force?: boolean;
}

// Pulls the text out of uploaded PDF, Word and plain-text files and stores
// it in attachments.text_content / tsv so the search can find them. Each
// file is one queue job; the per-workspace backfill job only fans out.
@Injectable()
export class AttachmentIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentIndexService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE)
    private readonly attachmentQueue: Queue,
  ) {}

  // Files uploaded before indexing existed get picked up on the next
  // start. The job skips anything already indexed, so this is cheap.
  async onApplicationBootstrap() {
    try {
      const workspaces = await this.db
        .selectFrom('workspaces')
        .select('id')
        .where('deletedAt', 'is', null)
        .execute();
      for (const workspace of workspaces) {
        await this.queueWorkspaceBackfill(workspace.id);
      }
    } catch (err: any) {
      this.logger.warn(`Could not queue attachment index backfill: ${err?.message}`);
    }
  }

  async queueWorkspaceBackfill(workspaceId: string, opts?: { force?: boolean }) {
    const payload: AttachmentIndexingJob = {
      workspaceId,
      force: opts?.force === true,
    };
    await this.attachmentQueue.add(QueueJob.ATTACHMENT_INDEXING, payload, {
      deduplication: { id: `attachment-indexing:${workspaceId}` },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  // Fans the workspace out into per-file jobs so retries and failures stay
  // per file. Returns how many files were queued.
  async indexAttachments(job: AttachmentIndexingJob): Promise<number> {
    let queued = 0;
    let lastId: string | null = null;

    for (;;) {
      const rows = await this.db
        .selectFrom('attachments')
        .select(['id', 'fileExt'])
        .where('workspaceId', '=', job.workspaceId)
        .where('type', '=', AttachmentType.File)
        .where('deletedAt', 'is', null)
        .where('pageId', 'is not', null)
        .$if(!job.force, (qb) => qb.where('indexedAt', 'is', null))
        .$if(lastId !== null, (qb) => qb.where('id', '>', lastId))
        .orderBy('id', 'asc')
        .limit(BACKFILL_BATCH)
        .execute();

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;

      for (const row of rows) {
        if (!isIndexableExtension(row.fileExt)) continue;
        await this.attachmentQueue.add(
          QueueJob.ATTACHMENT_INDEX_CONTENT,
          { attachmentId: row.id },
          {
            attempts: 2,
            backoff: { type: 'exponential', delay: 30_000 },
            deduplication: { id: `attachment-index:${row.id}` },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        queued++;
      }
    }

    if (queued > 0) {
      this.logger.log(
        `Queued ${queued} attachment(s) for indexing in workspace ${job.workspaceId}`,
      );
    }
    return queued;
  }

  // Extracts and stores the text of one file. Problems with the file itself
  // (unsupported, missing, too large, unreadable) still mark it indexed so
  // the backfill does not pick it up again; only unexpected errors throw,
  // which lets the queue retry.
  async indexAttachment(attachmentId: string): Promise<void> {
    const attachment = await this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'fileExt', 'filePath', 'fileSize', 'type', 'deletedAt'])
      .where('id', '=', attachmentId)
      .executeTakeFirst();

    if (!attachment || attachment.deletedAt || attachment.type !== AttachmentType.File) {
      return;
    }

    const ext = normalizeExtension(attachment.fileExt);
    if (!isIndexableExtension(ext)) {
      await this.store(attachment.id, attachment.fileName, null);
      return;
    }

    if (Number(attachment.fileSize ?? 0) > MAX_INDEXABLE_FILE_BYTES) {
      this.logger.warn(
        `Skipping text extraction for ${attachment.id}: ${attachment.fileSize} bytes is over the limit`,
      );
      await this.store(attachment.id, attachment.fileName, null);
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.storageService.read(attachment.filePath);
    } catch (err: any) {
      this.logger.warn(
        `Skipping text extraction for ${attachment.id}: cannot read ${attachment.filePath} (${err?.message})`,
      );
      await this.store(attachment.id, attachment.fileName, null);
      return;
    }

    if (buffer.length > MAX_INDEXABLE_FILE_BYTES) {
      await this.store(attachment.id, attachment.fileName, null);
      return;
    }

    let text: string | null = null;
    try {
      text = await this.extractTextFromBuffer(buffer, ext);
    } catch (err: any) {
      // A corrupt or password-protected file is not worth retrying.
      this.logger.warn(
        `Text extraction failed for ${attachment.id} (${attachment.fileName}): ${err?.message}`,
      );
    }

    await this.store(attachment.id, attachment.fileName, text);
  }

  // Also used by the AI chat for files attached to a message.
  async extractTextFromBuffer(buffer: Buffer, ext: string): Promise<string> {
    if (isPlainTextExtension(ext)) {
      return normalizeExtractedText(decodePlainText(buffer));
    }
    if (ext === '.pdf') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { extractText } = require('@docmost/pdf-inspector');
      return normalizeExtractedText(extractText(buffer));
    }
    if (ext === '.docx') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return normalizeExtractedText(result?.value);
    }
    return '';
  }

  // The file name is always searchable (weight A); the body, when there is
  // one, ranks below it (weight B).
  private async store(attachmentId: string, fileName: string, text: string | null) {
    const content = text && text.length > 0 ? text : null;
    const body = content ? content.slice(0, MAX_INDEXED_TEXT_CHARS) : '';
    await this.db
      .updateTable('attachments')
      .set({
        textContent: content,
        tsv: sql`setweight(to_tsvector('english', f_unaccent(${fileName ?? ''})), 'A') || setweight(to_tsvector('english', f_unaccent(${body})), 'B')`,
        indexedAt: new Date(),
      })
      .where('id', '=', attachmentId)
      .execute();
  }
}
