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
import { AiSettingsService } from '../ai-settings.service';
import { AiUsageService } from '../ai-usage.service';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { htmlToJson } from '../../../collaboration/collaboration.util';
import { markdownToHtml } from '@docmost/editor-ext';
import { AiTranscriptionService, Transcript } from './ai-transcription.service';
import {
  FINAL_SYSTEM,
  LIVE_SYSTEM,
  MAX_SEGMENTS,
  MeetingItem,
  MeetingLang,
  MeetingMode,
  MeetingSegment,
  MeetingSpeaker,
  NotesText,
  UserOp,
  applyModelOps,
  applyUserOp,
  cleanItems,
  cleanSegments,
  cleanSpeakers,
  finalPrompt,
  isMode,
  labelForms,
  labelPattern,
  livePrompt,
  meetingWords,
  mergeFinalItems,
  parseJson,
  parseOps,
  pickLang,
  renameOwners,
  renderNotes,
  speakerLabel,
  speakerStats,
  transcriptLines,
  turns,
} from './meeting-notes';

export const MEETING_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.oga', '.mp4', '.mpga', '.mpeg', '.flac', '.aac'];
export const MAX_MEETING_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_LIVE_CHUNK_BYTES = 25 * 1024 * 1024;
const LIVE_WINDOW_MS = 10 * 60 * 1000;
const LIVE_LIMIT = 40;
const LIVE_UPDATE_LIMIT = 60;
const MAX_TRANSCRIPT_FOR_SUMMARY = 120_000;
// how much new transcript one question to the model carries, and how many
// questions one update may ask (a client that was offline catches up)
const LIVE_ROUND_CHARS = 8_000;
const LIVE_ROUNDS = 3;
// less new text than this waits for the next update
const LIVE_MIN_CHARS = 60;
const LIVE_STALE_MS = 24 * 60 * 60 * 1000;
const FINAL_TIMEOUT_MS = 10 * 60 * 1000;

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
  mode: MeetingMode | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingSpeakerView extends MeetingSpeaker {
  // what the notes call this speaker now
  label: string;
  seconds: number;
  segments: number;
  // something they said, to recognise them by
  sample: string;
}

export interface MeetingDetailView extends MeetingNotesView {
  speakers: MeetingSpeakerView[];
  items: MeetingItem[];
  revision: number;
  aiAvailable: boolean;
  // the caller may name speakers (the owner, or anyone who can edit the page)
  canManage: boolean;
}

export interface LiveListView {
  items: MeetingItem[];
  revision: number;
  aiAvailable: boolean;
  stored: number;
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
    private readonly settings: AiSettingsService,
    private readonly usage: AiUsageService,
    private readonly collaborationGateway: CollaborationGateway,
    private readonly transcription: AiTranscriptionService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  // Where the notes go: an existing page the person can edit, or a space
  // they can create pages in.
  private async resolveTarget(
    user: User,
    workspace: Workspace,
    target: { pageId?: string | null; spaceId?: string | null },
  ): Promise<{ pageId: string | null; spaceId: string | null }> {
    if (target.pageId) {
      const page = await this.pageRepo.findById(target.pageId);
      if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw new NotFoundException('Page not found');
      await this.pageAccess.validateCanEdit(page, user);
      return { pageId: page.id, spaceId: page.spaceId };
    }
    if (!target.spaceId) throw new BadRequestException('Pick a page or a space for the notes');
    const ability = await this.spaceAbility.createForUser(user, target.spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new ForbiddenException('You cannot create pages in that space');
    return { pageId: null, spaceId: target.spaceId };
  }

  // The live meeting a recording finishes, when the id really is one of this person's.
  private async liveRowOf(user: User, workspace: Workspace, meetingId?: string | null) {
    if (!meetingId) return null;
    const row = await this.db
      .selectFrom('aiMeetingNotes')
      .selectAll()
      .where('id', '=', meetingId)
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .where('status', '=', 'live')
      .executeTakeFirst();
    return row ?? null;
  }

  async start(
    user: User,
    workspace: Workspace,
    filePromise: Promise<MultipartFile>,
    target: { pageId?: string; spaceId?: string; meetingId?: string; mode?: string },
  ): Promise<MeetingNotesView> {
    if (!(await this.transcription.isConfigured(workspace.id))) {
      throw new BadRequestException('No transcription model is set. An admin can pick one under Settings > AI.');
    }
    // the meeting whose list was kept while it ran, when the recorder had one
    const live = await this.liveRowOf(user, workspace, target.meetingId);
    const { pageId, spaceId } = live
      ? { pageId: live.pageId, spaceId: live.spaceId }
      : await this.resolveTarget(user, workspace, target);

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

    const mode = isMode(target.mode) ? target.mode : null;
    const row = live
      ? await this.db
          .updateTable('aiMeetingNotes')
          .set({ attachmentId: attachment.id, fileName: prepared.fileName, status: 'queued', mode: mode ?? live.mode, updatedAt: new Date() } as any)
          .where('id', '=', live.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await this.db
          .insertInto('aiMeetingNotes')
          .values({
            workspaceId: workspace.id,
            userId: user.id,
            pageId,
            spaceId,
            attachmentId: attachment.id,
            fileName: prepared.fileName,
            status: 'queued',
            mode,
          } as any)
          .returningAll()
          .executeTakeFirstOrThrow();
    await this.aiQueue.add(QueueJob.AI_MEETING_NOTES, { meetingId: row.id }, { removeOnComplete: true, removeOnFail: true, attempts: 1 });
    return view(row);
  }

  // The desktop app records and transcribes on the device (also with no
  // server); it sends the text and this only writes the notes. No audio and
  // no transcription model are involved.
  async startFromTranscript(
    user: User,
    workspace: Workspace,
    input: {
      pageId?: string;
      spaceId?: string;
      title?: string;
      transcript: string;
      language?: string;
      durationSeconds?: number;
      segments?: unknown[];
      meetingId?: string;
      mode?: string;
      speakers?: unknown[];
      locale?: string;
    },
  ): Promise<MeetingNotesView> {
    const text = input.transcript.trim();
    if (!text) throw new BadRequestException('The transcript is empty');
    const live = await this.liveRowOf(user, workspace, input.meetingId);
    const { pageId, spaceId } = live
      ? { pageId: live.pageId, spaceId: live.spaceId }
      : await this.resolveTarget(user, workspace, input);
    const speakers = cleanSpeakers(input.speakers);
    const known = new Set(speakers.map((sp) => sp.id));
    // a segment may only point at a speaker that came with it
    const segments = cleanSegments(input.segments).map((seg) => (seg.speaker && !known.has(seg.speaker) ? { ...seg, speaker: undefined } : seg));
    const mode = isMode(input.mode) ? input.mode : null;
    const values = {
      fileName: (input.title ?? '').trim().slice(0, 200) || live?.fileName || 'Meeting',
      status: 'queued',
      transcript: text,
      segments: segments,
      language: input.language?.slice(0, 20) ?? null,
      durationSeconds: input.durationSeconds ? Math.round(input.durationSeconds) : null,
    };
    const row = live
      ? await this.db
          .updateTable('aiMeetingNotes')
          .set({
            ...values,
            mode: mode ?? live.mode,
            // the final transcript names its own speakers; without them the live ones stay
            ...(speakers.length ? { speakers: speakers } : {}),
            ...(input.locale ? { notes: { lang: langFromLocale(input.locale) } } : {}),
            updatedAt: new Date(),
          } as any)
          .where('id', '=', live.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await this.db
          .insertInto('aiMeetingNotes')
          .values({
            ...values,
            workspaceId: workspace.id,
            userId: user.id,
            pageId,
            spaceId,
            attachmentId: null,
            mode,
            speakers: speakers,
            notes: input.locale ? { lang: langFromLocale(input.locale) } : null,
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

  // ------------------------------------------------------------ live list

  // One thing at a time per key: the model rounds of a meeting, and the
  // short reads-then-writes of its row.
  private readonly chains = new Map<string, Promise<unknown>>();

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.chains.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private readonly liveUpdates = new Map<string, number[]>();

  private async aiAvailable(workspaceId: string): Promise<boolean> {
    return Boolean(await this.settings.meetingsChoice(workspaceId).catch(() => null));
  }

  // A meeting starts: the row that will hold its transcript and its list.
  async liveStart(
    user: User,
    workspace: Workspace,
    input: { pageId?: string; spaceId?: string; title?: string; mode?: string; language?: string; locale?: string },
  ): Promise<MeetingDetailView> {
    const { pageId, spaceId } = await this.resolveTarget(user, workspace, input);
    // meetings that never finished (a crash, a closed tab) do not pile up
    await this.db
      .deleteFrom('aiMeetingNotes')
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .where('status', '=', 'live')
      .where('updatedAt', '<', new Date(Date.now() - LIVE_STALE_MS))
      .execute();
    const row = await this.db
      .insertInto('aiMeetingNotes')
      .values({
        workspaceId: workspace.id,
        userId: user.id,
        pageId,
        spaceId,
        attachmentId: null,
        fileName: (input.title ?? '').trim().slice(0, 200) || null,
        status: 'live',
        mode: isMode(input.mode) ? input.mode : null,
        language: input.language?.slice(0, 20) ?? null,
        notes: input.locale ? { lang: langFromLocale(input.locale) } : null,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.detail(row, user, true);
  }

  // New transcript from the recorder. The stored segments from `fromIndex`
  // on are replaced, then the model reads what it has not read yet and the
  // list comes back.
  async liveUpdate(
    user: User,
    workspace: Workspace,
    input: { meetingId: string; fromIndex: number; segments: unknown[]; speakers?: unknown[]; durationSeconds?: number },
  ): Promise<LiveListView> {
    const now = Date.now();
    const times = (this.liveUpdates.get(user.id) ?? []).filter((t) => now - t < LIVE_WINDOW_MS);
    if (times.length >= LIVE_UPDATE_LIMIT) throw new BadRequestException('Too many live updates; slow down');
    times.push(now);
    this.liveUpdates.set(user.id, times);

    const stored = await this.serial(`${input.meetingId}:row`, async () => {
      const row = await this.liveRowOf(user, workspace, input.meetingId);
      if (!row) throw new NotFoundException('This meeting is not running');
      const before = cleanSegments(row.segments);
      const from = Math.max(0, Math.min(Math.floor(input.fromIndex) || 0, before.length));
      const segments = before.slice(0, from).concat(cleanSegments(input.segments)).slice(0, MAX_SEGMENTS);
      const patch: Record<string, unknown> = {
        segments: segments,
        liveCursor: Math.min(row.liveCursor, segments.length),
      };
      if (input.speakers) patch.speakers = cleanSpeakers(input.speakers);
      if (input.durationSeconds) patch.durationSeconds = Math.round(input.durationSeconds);
      await this.set(row.id, patch);
      return segments.length;
    });

    // one model round at a time per meeting; edits by the person do not wait for it
    const aiAvailable = await this.serial(`${input.meetingId}:model`, () => this.readNewSegments(user, workspace, input.meetingId));
    const row = await this.db.selectFrom('aiMeetingNotes').select(['items', 'itemsRevision']).where('id', '=', input.meetingId).executeTakeFirst();
    return { items: cleanItems(row?.items), revision: row?.itemsRevision ?? 0, aiAvailable, stored };
  }

  // Lets the model read the part of a running meeting it has not read and
  // applies what it asks for. False when there is no model to ask, or it failed.
  private async readNewSegments(user: User, workspace: Workspace, meetingId: string): Promise<boolean> {
    if (!(await this.aiAvailable(workspace.id))) return false;
    for (let round = 0; round < LIVE_ROUNDS; round += 1) {
      const row = await this.liveRowOf(user, workspace, meetingId);
      if (!row) return true;
      const segments = cleanSegments(row.segments);
      const cursor = Math.min(row.liveCursor, segments.length);
      const fresh: MeetingSegment[] = [];
      let size = 0;
      for (const segment of segments.slice(cursor)) {
        if (fresh.length && size + segment.text.length > LIVE_ROUND_CHARS) break;
        fresh.push(segment);
        size += segment.text.length;
      }
      if (size < LIVE_MIN_CHARS) return true;
      const speakers = cleanSpeakers(row.speakers);
      const mode = isMode(row.mode) ? row.mode : null;
      const lang = langOf(row, user);
      const earlier = transcriptLines(turns(segments.slice(Math.max(0, cursor - 12), cursor), '', speakers, mode, lang)).slice(-1500);
      const text = transcriptLines(turns(fresh, '', speakers, mode, lang));
      let ops: ReturnType<typeof parseOps>;
      try {
        // each question to the model counts against the person's daily allowance
        await this.usage.assertAllowed(workspace, user);
        const { generateText } = await import('ai');
        const model = await this.providers.languageModel(workspace.id, await this.settings.meetingsChoice(workspace.id));
        const result = await generateText({
          model,
          system: LIVE_SYSTEM,
          prompt: livePrompt(cleanItems(row.items), earlier, text),
          temperature: 0.1,
          maxOutputTokens: 1_500,
          // a small model on a home server that had gone idle takes a while to load
          abortSignal: AbortSignal.timeout(120_000),
        });
        ops = parseOps(parseJson(result.text));
      } catch (err: any) {
        this.logger.warn(`live list ${meetingId}: ${String(err?.message ?? err).slice(0, 200)}`);
        return false;
      }
      const at = fresh[fresh.length - 1].end || fresh[fresh.length - 1].start || null;
      await this.serial(`${meetingId}:row`, async () => {
        // the list as it is now: the person may have edited it meanwhile
        const latest = await this.liveRowOf(user, workspace, meetingId);
        if (!latest) return;
        const applied = applyModelOps(cleanItems(latest.items), ops, at, text);
        await this.set(meetingId, {
          liveCursor: Math.min(cursor + fresh.length, cleanSegments(latest.segments).length),
          ...(applied.changed ? { items: applied.items, itemsRevision: latest.itemsRevision + 1 } : {}),
        });
      });
    }
    return true;
  }

  // The person edits the list by hand; what they touch is theirs from then on.
  async userItem(user: User, workspace: Workspace, input: { meetingId: string } & UserOp): Promise<{ items: MeetingItem[]; revision: number }> {
    return this.serial(`${input.meetingId}:row`, async () => {
      const row = await this.manageable(user, workspace, input.meetingId);
      let items: MeetingItem[];
      try {
        const segments = cleanSegments(row.segments);
        const at = segments.length ? segments[segments.length - 1].end : null;
        items = applyUserOp(cleanItems(row.items), input, at);
      } catch (err: any) {
        throw new BadRequestException(String(err?.message ?? 'Invalid entry'));
      }
      const revision = row.itemsRevision + 1;
      await this.set(row.id, { items: items, itemsRevision: revision });
      return { items, revision };
    });
  }

  async liveDiscard(user: User, workspace: Workspace, meetingId: string): Promise<{ ok: true }> {
    await this.db
      .deleteFrom('aiMeetingNotes')
      .where('id', '=', meetingId)
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .where('status', '=', 'live')
      .execute();
    return { ok: true };
  }

  // --------------------------------------------------- speakers and detail

  // The owner of the meeting, or anyone who can edit the page with its notes.
  private async manageable(user: User, workspace: Workspace, meetingId: string) {
    const row = await this.db.selectFrom('aiMeetingNotes').selectAll().where('id', '=', meetingId).where('workspaceId', '=', workspace.id).executeTakeFirst();
    if (!row) throw new NotFoundException('Not found');
    if (row.userId === user.id) return row;
    const page = row.pageId ? await this.pageRepo.findById(row.pageId) : null;
    if (!page || page.deletedAt) throw new NotFoundException('Not found');
    await this.pageAccess.validateCanEdit(page, user);
    return row;
  }

  private async detail(row: any, user: User, canManage: boolean): Promise<MeetingDetailView> {
    const speakers = cleanSpeakers(row.speakers);
    const mode = isMode(row.mode) ? row.mode : null;
    const lang = langOf(row, user);
    const stats = speakerStats(cleanSegments(row.segments));
    return {
      ...view(row),
      speakers: speakers.map((sp) => ({
        ...sp,
        label: speakerLabel(sp, mode, lang),
        seconds: stats.get(sp.id)?.seconds ?? 0,
        segments: stats.get(sp.id)?.segments ?? 0,
        sample: stats.get(sp.id)?.sample ?? '',
      })),
      items: cleanItems(row.items),
      revision: row.itemsRevision ?? 0,
      aiAvailable: await this.aiAvailable(row.workspaceId),
      canManage,
    };
  }

  async info(user: User, workspace: Workspace, meetingId: string): Promise<MeetingDetailView> {
    return this.detail(await this.manageable(user, workspace, meetingId), user, true);
  }

  // The meetings whose notes are on a page, newest first.
  async byPage(user: User, workspace: Workspace, pageId: string): Promise<MeetingDetailView[]> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanView(page, user);
    const canEdit = await this.pageAccess
      .validateCanEdit(page, user)
      .then(() => true)
      .catch(() => false);
    const rows = await this.db
      .selectFrom('aiMeetingNotes')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('pageId', '=', page.id)
      .where('status', '=', 'done')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .execute();
    return Promise.all(rows.map((row) => this.detail(row, user, canEdit || row.userId === user.id)));
  }

  // A speaker gets a name (or loses it): the meeting's data and the notes
  // already on the page follow.
  async renameSpeaker(user: User, workspace: Workspace, input: { meetingId: string; speakerId: string; name: string }): Promise<MeetingDetailView> {
    const row = await this.serial(`${input.meetingId}:row`, async () => {
      const current = await this.manageable(user, workspace, input.meetingId);
      const speakers = cleanSpeakers(current.speakers);
      const speaker = speakers.find((sp) => sp.id === input.speakerId);
      if (!speaker) throw new NotFoundException('That speaker is not in this meeting');
      const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
      if (name === speaker.name) return current;
      const mode = isMode(current.mode) ? current.mode : null;
      const pattern = labelPattern(labelForms(speaker, mode));
      speaker.name = name;
      const to = speakerLabel(speaker, mode, langOf(current, user));
      await this.set(current.id, {
        speakers: speakers,
        items: renameOwners(cleanItems(current.items), pattern, to),
      });
      await this.rewriteNotes(current, pattern, to, user);
      return this.db.selectFrom('aiMeetingNotes').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow();
    });
    return this.detail(row, user, true);
  }

  // Two entries were the same person: `from` disappears into `into`.
  async mergeSpeakers(user: User, workspace: Workspace, input: { meetingId: string; from: string; into: string }): Promise<MeetingDetailView> {
    const row = await this.serial(`${input.meetingId}:row`, async () => {
      const current = await this.manageable(user, workspace, input.meetingId);
      const speakers = cleanSpeakers(current.speakers);
      const from = speakers.find((sp) => sp.id === input.from);
      const into = speakers.find((sp) => sp.id === input.into);
      if (!from || !into || from.id === into.id) throw new BadRequestException('Pick two different speakers of this meeting');
      const mode = isMode(current.mode) ? current.mode : null;
      const pattern = labelPattern(labelForms(from, mode));
      const to = speakerLabel(into, mode, langOf(current, user));
      const segments = cleanSegments(current.segments).map((seg) => (seg.speaker === from.id ? { ...seg, speaker: into.id } : seg));
      await this.set(current.id, {
        speakers: speakers.filter((sp) => sp.id !== from.id),
        segments: segments,
        items: renameOwners(cleanItems(current.items), pattern, to),
      });
      await this.rewriteNotes(current, pattern, to, user);
      return this.db.selectFrom('aiMeetingNotes').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow();
    });
    return this.detail(row, user, true);
  }

  // Rewrites a speaker's label inside the notes of one meeting on its page.
  private async rewriteNotes(row: any, pattern: RegExp | null, to: string, user: User): Promise<void> {
    if (!pattern || !row.pageId || row.status !== 'done') return;
    const page = await this.pageRepo.findById(row.pageId);
    if (!page || page.deletedAt) return;
    const notes = (row.notes ?? {}) as { firstBlock?: string; lastBlock?: string };
    // without the blocks that mark where these notes start and end, another
    // meeting on the same page could be renamed too: better to leave the text
    if (!notes.firstBlock || !notes.lastBlock) return;
    await this.collaborationGateway.handleYjsEvent('replaceText', `page.${page.id}`, {
      pattern: pattern.source,
      flags: pattern.flags,
      to,
      fromBlockId: notes.firstBlock,
      toBlockId: notes.lastBlock,
      user,
    });
  }

  // -------------------------------------------------------------- the job

  async process(data: { meetingId: string }): Promise<void> {
    const row = await this.db.selectFrom('aiMeetingNotes').selectAll().where('id', '=', data.meetingId).executeTakeFirst();
    if (!row || row.status === 'done' || row.status === 'live') return;
    const user = await this.userRepo.findById(row.userId, row.workspaceId);
    if (!user) return;
    try {
      // a transcript made on the device arrives with the row; otherwise the
      // recording is transcribed here
      const fromDevice = !row.attachmentId && Boolean(row.transcript?.trim());
      let transcript: Transcript;
      let segments: MeetingSegment[];
      let attachment: Awaited<ReturnType<AttachmentRepo['findById']>> | null = null;
      if (fromDevice) {
        segments = cleanSegments(row.segments);
        transcript = { text: row.transcript, segments, language: row.language, durationSeconds: row.durationSeconds };
        await this.set(row.id, { status: 'summarizing' });
      } else {
        await this.set(row.id, { status: 'transcribing' });
        attachment = row.attachmentId ? await this.attachmentRepo.findById(row.attachmentId) : null;
        if (!attachment) throw new Error('The recording is gone');
        const audio = await this.storage.read(attachment.filePath);
        transcript = await this.transcription.transcribe(row.workspaceId, audio, attachment.fileName, attachment.mimeType ?? '');
        if (!transcript.text.trim()) throw new Error('The recording had no speech to transcribe');
        segments = cleanSegments(transcript.segments);
        await this.set(row.id, {
          status: 'summarizing',
          transcript: transcript.text,
          segments: segments,
          language: transcript.language,
          durationSeconds: transcript.durationSeconds,
        });
      }
      const label = attachment?.fileName ?? row.fileName ?? 'Meeting';
      const speakers = cleanSpeakers(row.speakers);
      const mode = isMode(row.mode) ? row.mode : null;
      // the recorder's own language when it said one, else the person's, else the one spoken
      const stored = (row.notes as { lang?: string } | null)?.lang;
      const lang: MeetingLang = stored === 'es' || stored === 'en' ? stored : pickLang(user.locale, transcript.language);
      const list = turns(segments, transcript.text, speakers, mode, lang);

      // the list kept while the meeting ran is where the final one starts
      let items = cleanItems(row.items);
      let notes: NotesText;
      let noSummary: string | null = null;
      try {
        const answer = await this.summarize(row.workspaceId, label, items, transcriptLines(list, false));
        notes = answer.notes;
        items = mergeFinalItems(items, answer.items, transcript.durationSeconds ?? null);
      } catch (err: any) {
        // no model, or one that did not answer: the transcript and the list
        // kept during the meeting are still worth having on the page
        noSummary = String(err?.message ?? err).slice(0, 300);
        this.logger.warn(`meeting notes ${row.id}: no summary (${noSummary})`);
        notes = { title: '', summary: '', topics: [] };
      }
      const markdown = renderNotes(notes, items, list, {
        fileName: label,
        durationSeconds: transcript.durationSeconds ?? null,
        language: transcript.language ?? null,
        mode,
        lang,
      });
      // the first and last block get known ids: that is how a later rename
      // finds these notes among whatever else the page holds
      const content = htmlToJson((await markdownToHtml(markdown)) as string);
      const marks = markBlocks(content, row.id);

      let pageId = row.pageId;
      if (pageId) {
        const page = await this.pageRepo.findById(pageId);
        if (!page || page.deletedAt) throw new Error('The page is gone');
        await this.pageService.update(page, { pageId: page.id, content, format: 'json', operation: 'append' } as any, user);
      } else {
        const page = await this.pageService.create(user.id, row.workspaceId, {
          spaceId: row.spaceId,
          title: notes.title || `${meetingWords(lang).notesTitle}: ${label}`,
          content,
          format: 'json',
        } as any);
        pageId = page.id;
        if (attachment) await this.attachmentRepo.updateAttachment({ pageId } as any, attachment.id).catch(() => undefined);
      }
      await this.set(row.id, {
        status: 'done',
        summary: notes.summary,
        pageId,
        // done, but say why the notes have no summary
        error: noSummary ? `No summary: ${noSummary}` : null,
        items: items,
        itemsRevision: row.itemsRevision + 1,
        notes: { title: notes.title, topics: notes.topics, lang, ...marks },
      });
      await this.notifications.create({
        userId: row.userId,
        workspaceId: row.workspaceId,
        type: NotificationType.AI_MEETING_NOTES_READY,
        actorId: null,
        pageId,
        spaceId: row.spaceId,
        data: { fileName: label, meetingId: row.id },
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

  // The final pass: summary and topics, and the list checked against everything that was said.
  private async summarize(workspaceId: string, label: string, items: MeetingItem[], transcript: string): Promise<{ notes: NotesText; items: unknown }> {
    const { generateText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId, await this.settings.meetingsChoice(workspaceId));
    const text = transcript.length > MAX_TRANSCRIPT_FOR_SUMMARY ? `${transcript.slice(0, MAX_TRANSCRIPT_FOR_SUMMARY)}\n[transcript truncated]` : transcript;
    const result = await generateText({
      model,
      system: FINAL_SYSTEM,
      prompt: finalPrompt(label, items, text),
      temperature: 0.2,
      maxOutputTokens: 4_000,
      // a model that stopped answering must not hold the notes back for ever
      abortSignal: AbortSignal.timeout(FINAL_TIMEOUT_MS),
    });
    const parsed = parseJson(result.text) ?? {};
    return {
      notes: {
        title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '',
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : result.text.trim().slice(0, 2000),
        topics: Array.isArray(parsed.topics) ? parsed.topics.map((v: unknown) => String(v ?? '').trim()).filter(Boolean).slice(0, 30) : [],
      },
      // older answers named the two kinds separately
      items: Array.isArray(parsed.items)
        ? parsed.items
        : [
            ...(Array.isArray(parsed.decisions) ? parsed.decisions.map((d: unknown) => ({ kind: 'agreement', text: String(d ?? '') })) : []),
            ...(Array.isArray(parsed.actionItems)
              ? parsed.actionItems.map((a: any) => ({ kind: 'task', text: String(a?.text ?? a ?? ''), owner: a?.owner ?? null }))
              : []),
          ],
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

function langFromLocale(locale: string): MeetingLang {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
}

// The language the notes of a meeting were (or will be) written in.
function langOf(row: any, user: User): MeetingLang {
  const stored = (row.notes as { lang?: string } | null)?.lang;
  return stored === 'es' || stored === 'en' ? stored : pickLang(user.locale, row.language);
}

// Gives the first and the last heading or paragraph of the notes an id of
// the meeting's own, and says which.
function markBlocks(content: any, meetingId: string): { firstBlock?: string; lastBlock?: string } {
  const blocks: any[] = Array.isArray(content?.content) ? content.content : [];
  const markable = blocks.filter((b) => b?.type === 'heading' || b?.type === 'paragraph');
  if (markable.length < 2) return {};
  const base = `m${meetingId.replace(/-/g, '').slice(0, 10)}`;
  const first = markable[0];
  const last = markable[markable.length - 1];
  first.attrs = { ...(first.attrs ?? {}), id: `${base}a` };
  last.attrs = { ...(last.attrs ?? {}), id: `${base}z` };
  return { firstBlock: `${base}a`, lastBlock: `${base}z` };
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
    mode: isMode(row.mode) ? row.mode : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
