import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { StorageService } from '../../../integrations/storage/storage.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { AttachmentType } from '../../attachment/attachment.constants';
import { getAttachmentFolderPath, prepareFile } from '../../attachment/attachment.utils';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { PageService } from '../../page/services/page.service';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { AiProviderService } from '../ai-provider.service';
import { AiTranscriptionService, Transcript, TranscriptSegment } from './ai-transcription.service';

export const MEETING_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.oga', '.mp4', '.mpga', '.mpeg', '.flac', '.aac'];
export const MAX_MEETING_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_LIVE_CHUNK_BYTES = 25 * 1024 * 1024;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const LIVE_LIMIT = 40;
const MAX_TRANSCRIPT_FOR_SUMMARY = 120_000;

export interface MeetingNotesView {
  id: string;
  status: string;
  fileName: string | null;
  pageId: string | null;
  spaceId: string | null;
  language: string | null;
  durationSeconds: number | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// Meeting notes from a recording: the file is kept as a page attachment, a
// queue job transcribes it, the model writes summary, decisions and action
// items, and the result lands on the page (or a new one). The person is
// told when it is ready.
@Injectable()
export class AiMeetingService {
  private readonly logger = new Logger(AiMeetingService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly userRepo: UserRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly storage: StorageService,
    private readonly pageAccess: PageAccessService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly notifications: NotificationService,
    private readonly providers: AiProviderService,
    private readonly transcription: AiTranscriptionService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  async start(
    user: User,
    workspace: Workspace,
    filePromise: Promise<MultipartFile>,
    target: { pageId?: string; spaceId?: string },
  ): Promise<MeetingNotesView> {
    if (!(await this.transcription.isConfigured(workspace.id))) {
      throw new BadRequestException('No transcription model is set. An admin can pick one under Settings > AI.');
    }
    let spaceId = target.spaceId ?? null;
    let pageId = target.pageId ?? null;
    if (pageId) {
      const page = await this.pageRepo.findById(pageId);
      if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw new NotFoundException('Page not found');
      await this.pageAccess.validateCanEdit(page, user);
      spaceId = page.spaceId;
    } else {
      if (!spaceId) throw new BadRequestException('Pick a page or a space for the notes');
      const ability = await this.spaceAbility.createForUser(user, spaceId);
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new ForbiddenException('You cannot create pages in that space');
    }

    const prepared = await prepareFile(filePromise);
    const ext = prepared.fileExtension.toLowerCase();
    if (!MEETING_AUDIO_EXTENSIONS.includes(ext)) {
      throw new BadRequestException(`Unsupported recording; use ${MEETING_AUDIO_EXTENSIONS.join(', ')}`);
    }
    if (!prepared.buffer?.length) throw new BadRequestException('Empty upload');
    if (prepared.fileSize > MAX_MEETING_FILE_BYTES) throw new PayloadTooLargeException('Recordings up to 200 MB');

    const id = randomUUID();
    const filePath = `${getAttachmentFolderPath(AttachmentType.File, workspace.id)}/${id}${ext}`;
    await this.storage.upload(filePath, prepared.buffer);
    const attachment = await this.attachmentRepo.insertAttachment({
      id,
      type: AttachmentType.File,
      filePath,
      fileName: prepared.fileName,
      fileSize: prepared.fileSize,
      fileExt: ext,
      mimeType: prepared.mimeType,
      creatorId: user.id,
      workspaceId: workspace.id,
      pageId,
      spaceId,
    } as any);

    const row = await this.db
      .insertInto('aiMeetingNotes')
      .values({
        workspaceId: workspace.id,
        userId: user.id,
        pageId,
        spaceId,
        attachmentId: attachment.id,
        fileName: prepared.fileName,
        status: 'queued',
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.aiQueue.add(QueueJob.AI_MEETING_NOTES, { meetingId: row.id }, { removeOnComplete: true, removeOnFail: true, attempts: 1 });
    return view(row);
  }

  // Live mode: a piece of the recording (a minute or so) comes in while the
  // meeting runs and goes back as text; nothing is stored.
  private readonly liveRecent = new Map<string, number[]>();

  async transcribeChunk(user: User, workspace: Workspace, filePromise: Promise<MultipartFile>): Promise<{ text: string; language: string | null }> {
    if (!(await this.transcription.isConfigured(workspace.id))) {
      throw new BadRequestException('No transcription model is set. An admin can pick one under Settings > AI.');
    }
    const now = Date.now();
    const times = (this.liveRecent.get(user.id) ?? []).filter((t) => now - t < LIVE_WINDOW_MS);
    if (times.length >= LIVE_LIMIT) throw new BadRequestException('Too many live chunks; slow down');
    times.push(now);
    this.liveRecent.set(user.id, times);
    const prepared = await prepareFile(filePromise);
    const ext = prepared.fileExtension.toLowerCase();
    if (!MEETING_AUDIO_EXTENSIONS.includes(ext)) throw new BadRequestException('Unsupported recording');
    if (!prepared.buffer?.length) return { text: '', language: null };
    if (prepared.fileSize > MAX_LIVE_CHUNK_BYTES) throw new PayloadTooLargeException('Chunks up to 25 MB');
    const transcript = await this.transcription.transcribe(workspace.id, prepared.buffer, prepared.fileName, prepared.mimeType);
    return { text: transcript.text, language: transcript.language };
  }

  async status(user: User, workspace: Workspace, meetingId: string): Promise<MeetingNotesView> {
    const row = await this.db
      .selectFrom('aiMeetingNotes')
      .selectAll()
      .where('id', '=', meetingId)
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Not found');
    return view(row);
  }

  async list(user: User, workspace: Workspace): Promise<MeetingNotesView[]> {
    const rows = await this.db
      .selectFrom('aiMeetingNotes')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .execute();
    return rows.map(view);
  }

  // The queue job.
  async process(data: { meetingId: string }): Promise<void> {
    const row = await this.db.selectFrom('aiMeetingNotes').selectAll().where('id', '=', data.meetingId).executeTakeFirst();
    if (!row || row.status === 'done') return;
    const user = await this.userRepo.findById(row.userId, row.workspaceId);
    if (!user) return;
    try {
      await this.set(row.id, { status: 'transcribing' });
      const attachment = row.attachmentId ? await this.attachmentRepo.findById(row.attachmentId) : null;
      if (!attachment) throw new Error('The recording is gone');
      const audio = await this.storage.read(attachment.filePath);
      const transcript = await this.transcription.transcribe(row.workspaceId, audio, attachment.fileName, attachment.mimeType ?? '');
      if (!transcript.text.trim()) throw new Error('The recording had no speech to transcribe');
      await this.set(row.id, {
        status: 'summarizing',
        transcript: transcript.text,
        segments: transcript.segments as any,
        language: transcript.language,
        durationSeconds: transcript.durationSeconds,
      });

      const notes = await this.summarize(row.workspaceId, transcript, attachment.fileName);
      const markdown = renderNotes(notes, transcript, attachment.fileName);

      let pageId = row.pageId;
      if (pageId) {
        const page = await this.pageRepo.findById(pageId);
        if (!page || page.deletedAt) throw new Error('The page is gone');
        await this.pageService.update(page, { pageId: page.id, content: markdown, format: 'markdown', operation: 'append' } as any, user);
      } else {
        const page = await this.pageService.create(user.id, row.workspaceId, {
          spaceId: row.spaceId,
          title: notes.title || `Meeting notes: ${attachment.fileName}`,
          content: markdown,
          format: 'markdown',
        } as any);
        pageId = page.id;
        await this.attachmentRepo.updateAttachment({ pageId } as any, attachment.id).catch(() => undefined);
      }
      await this.set(row.id, { status: 'done', summary: notes.summary, pageId, error: null });
      await this.notifications.create({
        userId: row.userId,
        workspaceId: row.workspaceId,
        type: NotificationType.AI_MEETING_NOTES_READY,
        actorId: null,
        pageId,
        spaceId: row.spaceId,
        data: { fileName: attachment.fileName, meetingId: row.id },
      } as any);
    } catch (err: any) {
      const message = String(err?.message ?? 'Transcription failed').slice(0, 500);
      this.logger.warn(`meeting notes ${row.id} failed: ${message}`);
      await this.set(row.id, { status: 'failed', error: message });
      await this.notifications
        .create({
          userId: row.userId,
          workspaceId: row.workspaceId,
          type: NotificationType.AI_MEETING_NOTES_FAILED,
          actorId: null,
          pageId: row.pageId,
          spaceId: row.spaceId,
          data: { fileName: row.fileName, error: message, meetingId: row.id },
        } as any)
        .catch(() => undefined);
    }
  }

  private async summarize(workspaceId: string, transcript: Transcript, fileName: string): Promise<MeetingSummary> {
    const { generateText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId);
    const text = transcript.text.length > MAX_TRANSCRIPT_FOR_SUMMARY ? `${transcript.text.slice(0, MAX_TRANSCRIPT_FOR_SUMMARY)}\n[transcript truncated]` : transcript.text;
    const result = await generateText({
      model,
      system:
        'You turn meeting transcripts into notes. Keep speaker labels ("Speaker 1:") when the transcript has them. Answer with one JSON object and nothing else: ' +
        '{"title": string, "summary": string (2-5 sentences), "topics": string[], "decisions": string[], "actionItems": [{"text": string, "owner": string|null}]}. ' +
        'Write in the language of the transcript. Never invent decisions or owners that were not said.',
      prompt: `Recording: ${fileName}\n\nTranscript:\n${text}`,
      temperature: 0.2,
      maxOutputTokens: 3_000,
    });
    const parsed = parseJson(result.text) ?? {};
    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '',
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : result.text.trim().slice(0, 2000),
      topics: strings(parsed.topics),
      decisions: strings(parsed.decisions),
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems
            .map((a: any) => ({ text: String(a?.text ?? a ?? '').trim(), owner: a?.owner ? String(a.owner).trim() : null }))
            .filter((a: any) => a.text)
        : [],
    };
  }

  private async set(id: string, patch: Record<string, unknown>) {
    await this.db
      .updateTable('aiMeetingNotes')
      .set({ ...patch, updatedAt: new Date() } as any)
      .where('id', '=', id)
      .execute();
  }
}

interface MeetingSummary {
  title: string;
  summary: string;
  topics: string[];
  decisions: string[];
  actionItems: { text: string; owner: string | null }[];
}

function renderNotes(notes: MeetingSummary, transcript: Transcript, fileName: string): string {
  const lines: string[] = [];
  lines.push(`## Summary`, '', notes.summary, '');
  if (notes.topics.length) lines.push(`**Topics:** ${notes.topics.join(' · ')}`, '');
  if (notes.decisions.length) {
    lines.push(`## Decisions`, '');
    for (const d of notes.decisions) lines.push(`- ${d}`);
    lines.push('');
  }
  if (notes.actionItems.length) {
    lines.push(`## Action items`, '');
    for (const a of notes.actionItems) lines.push(`- [ ] ${a.text}${a.owner ? ` — ${a.owner}` : ''}`);
    lines.push('');
  }
  lines.push(`## Transcript`, '');
  lines.push(`_${fileName}${transcript.durationSeconds ? ` · ${stamp(transcript.durationSeconds)}` : ''}${transcript.language ? ` · ${transcript.language}` : ''}_`, '');
  for (const block of groupSegments(transcript.segments, transcript.text)) {
    lines.push(block.start === null ? block.text : `**[${stamp(block.start)}]** ${block.text}`, '');
  }
  return lines.join('\n');
}

// Paragraphs of roughly 500 characters, each stamped with when it starts.
function groupSegments(segments: TranscriptSegment[], fallback: string): { start: number | null; text: string }[] {
  if (!segments.length) {
    return fallback
      .split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/)
      .reduce<string[]>((acc, s) => {
        const last = acc[acc.length - 1];
        if (last && last.length + s.length < 500) acc[acc.length - 1] = `${last} ${s}`;
        else acc.push(s);
        return acc;
      }, [])
      .map((text) => ({ start: null, text: text.trim() }))
      .filter((b) => b.text);
  }
  const out: { start: number | null; text: string }[] = [];
  let current: { start: number; text: string } | null = null;
  for (const s of segments) {
    if (!current) current = { start: s.start, text: s.text };
    else if (current.text.length + s.text.length < 500 && s.start - current.start < 120) current.text = `${current.text} ${s.text}`;
    else {
      out.push(current);
      current = { start: s.start, text: s.text };
    }
  }
  if (current) out.push(current);
  return out;
}

function stamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function parseJson(text: string): any | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 30) : [];
}

function view(row: any): MeetingNotesView {
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName ?? null,
    pageId: row.pageId ?? null,
    spaceId: row.spaceId ?? null,
    language: row.language ?? null,
    durationSeconds: row.durationSeconds ?? null,
    summary: row.summary ?? null,
    error: row.error ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
