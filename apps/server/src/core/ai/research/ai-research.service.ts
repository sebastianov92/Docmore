import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { PageService } from '../../page/services/page.service';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { AiProviderService } from '../ai-provider.service';
import { AiChatRepo } from '../chat/ai-chat.repo';
import { AiChatToolsService, pageUrl, ToolContext } from '../chat/ai-chat-tools.service';

export interface ResearchSource {
  n: number;
  pageId: string;
  title: string;
  url: string;
}

export interface ResearchView {
  id: string;
  chatId: string | null;
  question: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: { step: string; done: number; total: number; note?: string } | null;
  report: string | null;
  sources: ResearchSource[];
  pageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const MAX_SUBQUESTIONS = 6;
const MAX_SOURCES = 12;
const MAX_SOURCE_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 70_000;
const MAX_REPORT_TOKENS = 8_192;

// Research mode: a question becomes a plan of sub-questions, each is looked
// up in the wiki as the asking user, the pages are read, and the model
// writes a long report with numbered citations. Runs on the AI queue; the
// result lands in the chat and the person is told.
@Injectable()
export class AiResearchService {
  private readonly logger = new Logger(AiResearchService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly chats: AiChatRepo,
    private readonly tools: AiChatToolsService,
    private readonly providers: AiProviderService,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly notifications: NotificationService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  async start(user: User, workspace: Workspace, input: { question: string; chatId?: string; spaceId?: string }): Promise<ResearchView> {
    const question = input.question.trim();
    if (question.length < 8) throw new BadRequestException('Ask a fuller question');
    let chatId = input.chatId ?? null;
    if (chatId) {
      const chat = await this.chats.findChat(chatId, workspace.id);
      if (!chat || chat.creatorId !== user.id) throw new NotFoundException('Chat not found');
    } else {
      const chat = await this.chats.createChat({ workspaceId: workspace.id, creatorId: user.id, title: question.slice(0, 60) });
      chatId = chat.id;
    }
    const row = await this.db
      .insertInto('aiResearchReports')
      .values({
        workspaceId: workspace.id,
        userId: user.id,
        chatId,
        spaceId: input.spaceId ?? null,
        question,
        status: 'queued',
        progress: { step: 'queued', done: 0, total: 0 } as any,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.chats.insertMessage({
      chatId,
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      content: question,
      metadata: { research: { reportId: row.id } },
    });
    await this.aiQueue.add(QueueJob.AI_RESEARCH, { reportId: row.id }, { removeOnComplete: true, removeOnFail: true, attempts: 1 });
    return view(row);
  }

  async status(user: User, workspace: Workspace, reportId: string): Promise<ResearchView> {
    return view(await this.owned(user, workspace, reportId));
  }

  async list(user: User, workspace: Workspace): Promise<ResearchView[]> {
    const rows = await this.db
      .selectFrom('aiResearchReports')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .execute();
    return rows.map(view);
  }

  // The finished report as a new page, with its sources at the end.
  async saveAsPage(user: User, workspace: Workspace, input: { reportId: string; spaceId: string; parentPageId?: string }) {
    const row = await this.owned(user, workspace, input.reportId);
    if (row.status !== 'done' || !row.report) throw new BadRequestException('The report is not ready');
    const ability = await this.spaceAbility.createForUser(user, input.spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new ForbiddenException('You cannot create pages in that space');
    const page = await this.pageService.create(user.id, workspace.id, {
      spaceId: input.spaceId,
      title: row.question.slice(0, 200),
      content: row.report,
      format: 'markdown',
      parentPageId: input.parentPageId,
    } as any);
    await this.db.updateTable('aiResearchReports').set({ pageId: page.id, updatedAt: new Date() }).where('id', '=', row.id).execute();
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', page.spaceId).executeTakeFirst();
    return { pageId: page.id, title: page.title, slugId: page.slugId, url: pageUrl(space?.slug ?? null, page.slugId) };
  }

  // The queue job.
  async process(data: { reportId: string }): Promise<void> {
    const row = await this.db.selectFrom('aiResearchReports').selectAll().where('id', '=', data.reportId).executeTakeFirst();
    if (!row || row.status === 'done') return;
    const [user, workspace] = await Promise.all([this.userRepo.findById(row.userId, row.workspaceId), this.workspaceRepo.findById(row.workspaceId)]);
    if (!user || !workspace) return;
    const ctx: ToolContext = { user, workspace, readOnly: true };
    const usage = { promptTokens: 0, completionTokens: 0 };
    try {
      await this.set(row.id, { status: 'running', progress: { step: 'planning', done: 0, total: 0 } });
      const { generateText } = await import('ai');
      const model = await this.providers.languageModel(row.workspaceId);
      const count = (r: any) => {
        usage.promptTokens += Number(r.usage?.inputTokens ?? 0);
        usage.completionTokens += Number(r.usage?.outputTokens ?? 0);
      };

      // 1. plan
      const plan = await generateText({
        model,
        system:
          'You plan research inside a team wiki. Given a question, list the 3 to 6 sub-questions whose answers together answer it, each a short search query in the language of the question. Answer with a JSON array of strings and nothing else.',
        prompt: row.question,
        temperature: 0.3,
        maxOutputTokens: 600,
      });
      count(plan);
      const subQuestions = (parseArray(plan.text) ?? [row.question]).slice(0, MAX_SUBQUESTIONS);
      if (!subQuestions.includes(row.question)) subQuestions.unshift(row.question);

      // 2. search
      const picked = new Map<string, { pageId: string; title: string; url: string; excerpt: string }>();
      for (let i = 0; i < subQuestions.length; i += 1) {
        await this.set(row.id, { progress: { step: 'searching', done: i, total: subQuestions.length, note: subQuestions[i] } });
        const found = await this.tools.searchAs(ctx, subQuestions[i], row.spaceId ?? undefined);
        for (const r of (found as any).results ?? []) {
          if (picked.size >= MAX_SOURCES) break;
          if (!picked.has(r.pageId)) picked.set(r.pageId, { pageId: r.pageId, title: r.title, url: r.url, excerpt: r.excerpt ?? '' });
        }
      }
      if (picked.size === 0) throw new Error('Nothing in the wiki matches this question');

      // 3. read
      const sources: ResearchSource[] = [];
      const bodies: string[] = [];
      let used = 0;
      let n = 0;
      for (const candidate of picked.values()) {
        n += 1;
        await this.set(row.id, { progress: { step: 'reading', done: n - 1, total: picked.size, note: candidate.title } });
        const page = (await this.tools.readAs(ctx, candidate.pageId)) as any;
        if (page?.error) continue;
        const content = String(page.content ?? candidate.excerpt).slice(0, MAX_SOURCE_CHARS);
        if (used + content.length > MAX_CONTEXT_CHARS) break;
        used += content.length;
        const idx = sources.length + 1;
        sources.push({ n: idx, pageId: candidate.pageId, title: page.title || candidate.title || 'Untitled', url: page.url || candidate.url });
        bodies.push(`### [${idx}] ${page.title || candidate.title}\nURL: ${page.url || candidate.url}\n\n${content}`);
      }
      if (!sources.length) throw new Error('None of the matching pages could be read');

      // 4. write
      await this.set(row.id, { progress: { step: 'writing', done: 0, total: 1 } });
      const report = await generateText({
        model,
        system: [
          'You write research reports from a team wiki for someone who needs the full picture.',
          'Use only the numbered sources given. Cite them inline as [n] after each claim; never cite a number that is not in the list.',
          'Structure: a one-paragraph answer first, then sections with headings covering each sub-question, then "Open questions" for what the sources do not settle, then a "Sources" section listing every cited source as "[n] [Title](url)".',
          'Write in the language of the question. Markdown. Be thorough but never pad; say plainly when the wiki has little on a point.',
        ].join(' '),
        prompt: `Question: ${row.question}\n\nSub-questions:\n${subQuestions.map((q) => `- ${q}`).join('\n')}\n\nSources:\n\n${bodies.join('\n\n')}`,
        temperature: 0.3,
        maxOutputTokens: MAX_REPORT_TOKENS,
      });
      count(report);
      const text = report.text.trim();
      if (!text) throw new Error('The model returned an empty report');

      await this.set(row.id, { status: 'done', report: text, sources: sources as any, usage, progress: { step: 'done', done: 1, total: 1 }, error: null });
      if (row.chatId) {
        await this.chats.insertMessage({
          chatId: row.chatId,
          workspaceId: row.workspaceId,
          userId: null,
          role: 'assistant',
          content: text,
          metadata: { research: { reportId: row.id, sources, subQuestions }, tokenUsage: usage },
        });
        await this.chats.touchChat(row.chatId);
      }
      await this.notifications
        .create({ userId: row.userId, workspaceId: row.workspaceId, type: NotificationType.AI_RESEARCH_COMPLETED, actorId: null, data: { question: row.question, reportId: row.id, chatId: row.chatId } } as any)
        .catch(() => undefined);
    } catch (err: any) {
      const message = String(err?.message ?? 'Research failed').slice(0, 500);
      this.logger.warn(`research ${row.id} failed: ${message}`);
      await this.set(row.id, { status: 'failed', error: message, usage });
      if (row.chatId) {
        await this.chats
          .insertMessage({ chatId: row.chatId, workspaceId: row.workspaceId, userId: null, role: 'assistant', content: null, metadata: { research: { reportId: row.id }, error: message } })
          .catch(() => undefined);
      }
    }
  }

  private async owned(user: User, workspace: Workspace, reportId: string) {
    const row = await this.db
      .selectFrom('aiResearchReports')
      .selectAll()
      .where('id', '=', reportId)
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  private async set(id: string, patch: Record<string, unknown>) {
    await this.db
      .updateTable('aiResearchReports')
      .set({ ...patch, updatedAt: new Date() } as any)
      .where('id', '=', id)
      .execute();
  }
}

function parseArray(text: string): string[] | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.map((p) => String(p ?? '').trim()).filter((p) => p.length > 2) : null;
  } catch {
    return null;
  }
}

function view(row: any): ResearchView {
  return {
    id: row.id,
    chatId: row.chatId ?? null,
    question: row.question,
    status: row.status,
    progress: (row.progress as any) ?? null,
    report: row.report ?? null,
    sources: Array.isArray(row.sources) ? (row.sources as ResearchSource[]) : [],
    pageId: row.pageId ?? null,
    error: row.error ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
