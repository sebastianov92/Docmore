import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EnvironmentService } from '../../environment/environment.service';
import { StorageService } from '../../storage/storage.service';
import { TokenService } from '../../../core/auth/services/token.service';
import { JwtType } from '../../../core/auth/dto/jwt-payload';
import { QueueJob, QueueName } from '../../queue/constants';
import { sanitizeFileName } from '../../../common/helpers';
import { FileTaskStatus, FileTaskType, getFileTaskFolderPath } from '../../import/utils/file.utils';

export const PDF_EXPORT_SOURCE = 'pdf';
// Finished PDFs are kept this long for download, then removed.
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;
// Gotenberg waits up to this long for the page to say it is ready.
const RENDER_TIMEOUT_S = 60;

export interface PdfRenderPayload {
  pageId: string;
  workspaceId: string;
  type: 'pdf_render';
}

// Page to PDF through Gotenberg's Chromium: the app renders the page at
// /pdf-render with a short-lived token, Chromium prints it, the result is
// stored as an export file task the client polls and downloads.
@Injectable()
export class PdfExportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PdfExportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environment: EnvironmentService,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
    private readonly pageRepo: PageRepo,
    @InjectQueue(QueueName.FILE_TASK_QUEUE) private readonly fileTaskQueue: Queue,
  ) {}

  async onApplicationBootstrap() {
    if (!this.isConfigured()) return;
    try {
      await this.fileTaskQueue.add(
        QueueJob.PDF_EXPORT_CLEANUP,
        {},
        { jobId: 'pdf-export-cleanup', repeat: { every: CLEANUP_EVERY_MS }, removeOnComplete: true, removeOnFail: true },
      );
    } catch (err: any) {
      this.logger.warn(`Could not schedule PDF export cleanup: ${err?.message}`);
    }
  }

  isConfigured(): boolean {
    return Boolean(this.environment.getGotenbergUrl());
  }

  // Creates the export task and queues the render.
  async start(page: Page, user: User): Promise<{ fileTaskId: string }> {
    if (!this.isConfigured()) {
      throw new BadRequestException('PDF export is not set up on this server: set GOTENBERG_URL');
    }
    const title = page.title?.trim() || 'untitled';
    const task = await this.db
      .insertInto('fileTasks')
      .values({
        type: FileTaskType.Export,
        source: PDF_EXPORT_SOURCE,
        status: FileTaskStatus.Processing,
        fileName: `${sanitizeFileName(title, { preserveSpaces: true })}.pdf`,
        filePath: '',
        fileExt: 'pdf',
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        creatorId: user.id,
        metadata: { format: 'pdf', title } as any,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    const filePath = `${getFileTaskFolderPath(FileTaskType.Export, page.workspaceId)}/${task.id}.pdf`;
    await this.db.updateTable('fileTasks').set({ filePath }).where('id', '=', task.id).execute();

    await this.fileTaskQueue.add(
      QueueJob.PDF_EXPORT_TASK,
      { fileTaskId: task.id },
      { attempts: 2, backoff: { type: 'fixed', delay: 5_000 }, removeOnComplete: true, removeOnFail: true },
    );
    return { fileTaskId: task.id };
  }

  // What the render page needs; the token stands in for a session.
  async renderData(pageId: string, token: string) {
    const payload = await this.verifyRenderToken(token);
    if (payload.pageId !== pageId) {
      throw new NotFoundException('Page not found');
    }
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page || page.deletedAt || page.workspaceId !== payload.workspaceId) {
      throw new NotFoundException('Page not found');
    }
    return {
      pageId: page.id,
      title: page.title ?? '',
      content: rewriteFileUrls(page.content, token),
    };
  }

  // Files embedded in the page, fetched by Chromium with the render token
  // instead of a cookie. Only the page's own space is reachable.
  async fileForRender(token: string, fileId: string) {
    const payload = await this.verifyRenderToken(token);
    const attachment = await this.db
      .selectFrom('attachments')
      .select(['id', 'filePath', 'fileName', 'mimeType', 'fileSize', 'workspaceId', 'spaceId', 'pageId'])
      .where('id', '=', fileId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!attachment || attachment.workspaceId !== payload.workspaceId) {
      throw new NotFoundException();
    }
    const page = await this.pageRepo.findById(payload.pageId);
    if (!page || (attachment.pageId !== page.id && attachment.spaceId !== page.spaceId)) {
      throw new NotFoundException();
    }
    return attachment;
  }

  // Runs on the queue: ask Gotenberg to print the render page.
  async generateAndStorePdf(fileTaskId: string): Promise<void> {
    const task = await this.db
      .selectFrom('fileTasks')
      .selectAll()
      .where('id', '=', fileTaskId)
      .executeTakeFirst();
    if (!task || task.source !== PDF_EXPORT_SOURCE || !task.pageId) {
      this.logger.warn(`PDF export task ${fileTaskId} not found`);
      return;
    }
    const gotenberg = this.environment.getGotenbergUrl()?.replace(/\/+$/, '');
    if (!gotenberg) throw new Error('GOTENBERG_URL is not set');

    const token = await this.tokens.generatePdfRenderToken(task.pageId, task.workspaceId);
    const base = this.environment.getPdfRenderBaseUrl().replace(/\/+$/, '');
    const url = `${base}/pdf-render/${task.pageId}?token=${encodeURIComponent(token)}`;

    const form = new FormData();
    form.append('url', url);
    form.append('paperWidth', '8.27');
    form.append('paperHeight', '11.69');
    form.append('marginTop', '0.6');
    form.append('marginBottom', '0.6');
    form.append('marginLeft', '0.6');
    form.append('marginRight', '0.6');
    form.append('printBackground', 'true');
    form.append('waitForExpression', 'window.__pdfReady === true');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (RENDER_TIMEOUT_S + 15) * 1000);
    let pdf: Buffer;
    try {
      const res = await fetch(`${gotenberg}/forms/chromium/convert/url`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
        headers: { 'Gotenberg-Output-Filename': 'page' },
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Gotenberg answered ${res.status}${text ? `: ${text}` : ''}`);
      }
      pdf = Buffer.from(await res.arrayBuffer());
    } catch (err: any) {
      const reason =
        err?.name === 'AbortError'
          ? 'The PDF renderer did not answer in time'
          : /ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(err?.message ?? '')
            ? `Could not reach the PDF renderer at ${gotenberg}`
            : err?.message ?? 'PDF rendering failed';
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
    }

    await this.storage.upload(task.filePath, pdf);
    await this.db
      .updateTable('fileTasks')
      .set({ status: FileTaskStatus.Success, fileSize: pdf.length, errorMessage: null, updatedAt: new Date() })
      .where('id', '=', task.id)
      .execute();
    this.logger.log(`PDF export ${task.id} ready (${pdf.length} bytes)`);
  }

  async cleanupExpiredExports(): Promise<void> {
    const cutoff = new Date(Date.now() - EXPORT_TTL_MS);
    const expired = await this.db
      .selectFrom('fileTasks')
      .select(['id', 'filePath', 'status'])
      .where('type', '=', FileTaskType.Export)
      .where('source', '=', PDF_EXPORT_SOURCE)
      .where('createdAt', '<', cutoff)
      .limit(200)
      .execute();
    for (const task of expired) {
      if (task.filePath) await this.storage.delete(task.filePath).catch(() => undefined);
      await this.db.deleteFrom('fileTasks').where('id', '=', task.id).execute();
    }
    if (expired.length) this.logger.log(`Removed ${expired.length} expired PDF exports`);
  }

  private async verifyRenderToken(token: string): Promise<PdfRenderPayload> {
    try {
      return (await this.tokens.verifyJwt(token, JwtType.PDF_RENDER)) as PdfRenderPayload;
    } catch {
      throw new NotFoundException('Page not found');
    }
  }
}

// Images, files, videos and diagrams in the page point at /api/files, which
// needs a session; for the print run they go through the token route.
export function rewriteFileUrls(content: unknown, token: string): unknown {
  const prefix = `/api/pdf-export/files/${encodeURIComponent(token)}/`;
  const rewrite = (value: string): string => {
    const match = /^\/(?:api\/)?files\/(.+)$/.exec(value);
    return match ? prefix + match[1] : value;
  };
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'attrs' && value && typeof value === 'object') {
        const attrs: Record<string, unknown> = { ...(value as Record<string, unknown>) };
        for (const field of ['src', 'url']) {
          if (typeof attrs[field] === 'string') attrs[field] = rewrite(attrs[field] as string);
        }
        out[key] = attrs;
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  return walk(content);
}
