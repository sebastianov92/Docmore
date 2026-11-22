import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { UserRole } from '../../../common/helpers/types/permission';
import { PageService } from '../../page/services/page.service';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { PageSuggestionService } from '../../page/suggestions/page-suggestion.service';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../casl/interfaces/space-ability.type';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/notification.constants';
import { AiProviderService } from '../ai-provider.service';
import { AiSettingsService } from '../ai-settings.service';
import { AiUsageService } from '../ai-usage.service';
import { AiChatToolsService, pageUrl, ToolContext } from '../chat/ai-chat-tools.service';
import { AgentSchedule, dayLabel, nextRun, partsIn, readSchedule } from './agent-schedule';

export interface AgentOutput {
  // a new page each run, a dated section added to one page, or only a notification
  kind: 'page' | 'append' | 'notify';
  spaceId?: string | null;
  parentPageId?: string | null;
  pageId?: string | null;
}

type PageBrief = { id: string; title: string; url: string };

export interface AgentView {
  id: string;
  name: string;
  instructions: string;
  spaceId: string | null;
  space: { id: string; name: string; slug: string } | null;
  schedule: AgentSchedule;
  output: AgentOutput;
  // the page the result is added to, or the parent of the pages it makes
  outputPage: PageBrief | null;
  outputSpace: { id: string; name: string; slug: string } | null;
  allowEdits: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  creator: { id: string; name: string; avatarUrl: string | null } | null;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunView {
  id: string;
  agentId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  trigger: 'schedule' | 'manual';
  result: string | null;
  error: string | null;
  page: PageBrief | null;
  // what the run left behind besides its result
  suggestions: Array<{ suggestionId: string; title: string; reviewUrl: string }>;
  created: PageBrief[];
  steps: Array<{ name: string; detail: string }>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AgentInput {
  name?: string;
  instructions?: string;
  spaceId?: string | null;
  schedule?: unknown;
  output?: unknown;
  allowEdits?: boolean;
  enabled?: boolean;
}

export const MAX_AGENTS_PER_PERSON = 20;
const MAX_NAME = 100;
const MIN_INSTRUCTIONS = 10;
const MAX_INSTRUCTIONS = 6_000;
const MAX_STEPS = 16;
const MAX_OUTPUT_TOKENS = 6_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_RESULT_CHARS = 60_000;
// a run that never came back (the server stopped mid-run) is given up after this
const STALE_RUN_MS = 20 * 60_000;
// so many failures in a row and the agent is paused
const FAILURES_TO_PAUSE = 5;
const DUE_PER_TICK = 20;

// Scheduled agents: a task in words, a schedule and a place for the result.
// When its time comes the model works alone, with the tools of the chat and
// the permissions of the person who made the agent.
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pageService: PageService,
    private readonly pageAccess: PageAccessService,
    private readonly suggestions: PageSuggestionService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly notifications: NotificationService,
    private readonly providers: AiProviderService,
    private readonly settings: AiSettingsService,
    private readonly usage: AiUsageService,
    private readonly tools: AiChatToolsService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  // ---- the person's agents ------------------------------------------------

  // A person sees their own; an admin sees everyone's, to pause or remove.
  async list(user: User, workspace: Workspace): Promise<AgentView[]> {
    let q = this.db.selectFrom('aiAgents').selectAll().where('workspaceId', '=', workspace.id);
    if (!isAdmin(user)) q = q.where('creatorId', '=', user.id);
    const rows = await q.orderBy('createdAt', 'asc').limit(500).execute();
    return Promise.all(rows.map((row) => this.view(row, user)));
  }

  async info(user: User, workspace: Workspace, agentId: string): Promise<AgentView> {
    return this.view(await this.visible(user, workspace, agentId), user);
  }

  async create(user: User, workspace: Workspace, input: AgentInput): Promise<AgentView> {
    await this.assertMayUse(user, workspace);
    const count = await this.db
      .selectFrom('aiAgents')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspace.id)
      .where('creatorId', '=', user.id)
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= MAX_AGENTS_PER_PERSON) {
      throw new BadRequestException(`A person can have up to ${MAX_AGENTS_PER_PERSON} agents`);
    }
    const name = readName(input.name);
    const instructions = readInstructions(input.instructions);
    const schedule = readSchedule(input.schedule);
    const spaceId = await this.readSpace(user, workspace, input.spaceId);
    const output = await this.readOutput(user, workspace, input.output, spaceId);
    const enabled = input.enabled !== false;
    const row = await this.db
      .insertInto('aiAgents')
      .values({
        workspaceId: workspace.id,
        creatorId: user.id,
        name,
        instructions,
        spaceId,
        schedule: schedule as any,
        output: output as any,
        allowEdits: input.allowEdits === true,
        enabled,
        nextRunAt: enabled ? nextRun(schedule, new Date()) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.view(row, user);
  }

  // The person who made it changes anything; an admin only pauses it.
  async update(user: User, workspace: Workspace, agentId: string, input: AgentInput): Promise<AgentView> {
    const row = await this.visible(user, workspace, agentId);
    const mine = row.creatorId === user.id;
    const touchesTask = ['name', 'instructions', 'spaceId', 'schedule', 'output', 'allowEdits'].some((key) => (input as any)[key] !== undefined);
    if (!mine && touchesTask) throw new ForbiddenException('Only the person who made the agent changes what it does');
    if (!mine && input.enabled === true) throw new ForbiddenException('Only the person who made the agent turns it on');

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = readName(input.name);
    if (input.instructions !== undefined) patch.instructions = readInstructions(input.instructions);
    const spaceId = input.spaceId !== undefined ? await this.readSpace(user, workspace, input.spaceId) : row.spaceId;
    if (input.spaceId !== undefined) patch.spaceId = spaceId;
    // the place for the result is checked again when the space changes
    if (input.output !== undefined || input.spaceId !== undefined) {
      patch.output = await this.readOutput(user, workspace, input.output ?? row.output, spaceId);
    }
    if (input.allowEdits !== undefined) patch.allowEdits = input.allowEdits === true;
    const schedule = input.schedule !== undefined ? readSchedule(input.schedule) : readSchedule(row.schedule);
    if (input.schedule !== undefined) patch.schedule = schedule;
    const enabled = input.enabled !== undefined ? input.enabled === true : row.enabled;
    if (input.enabled !== undefined) {
      patch.enabled = enabled;
      // turned on again by hand: the count of failures starts over
      if (enabled) patch.failures = 0;
    }
    if (input.schedule !== undefined || input.enabled !== undefined) {
      patch.nextRunAt = enabled ? nextRun(schedule, new Date()) : null;
    }
    const updated = await this.db.updateTable('aiAgents').set(patch as any).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
    return this.view(updated, user);
  }

  async remove(user: User, workspace: Workspace, agentId: string): Promise<{ ok: true }> {
    const row = await this.visible(user, workspace, agentId);
    await this.db.deleteFrom('aiAgents').where('id', '=', row.id).execute();
    return { ok: true };
  }

  // Runs it now, whatever its schedule says.
  async runNow(user: User, workspace: Workspace, agentId: string): Promise<AgentRunView> {
    const row = await this.visible(user, workspace, agentId);
    if (row.creatorId !== user.id) throw new ForbiddenException('Only the person who made the agent runs it');
    await this.assertMayUse(user, workspace);
    await this.giveUpStaleRuns();
    const busy = await this.db
      .selectFrom('aiAgentRuns')
      .select('id')
      .where('agentId', '=', row.id)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirst();
    if (busy) throw new BadRequestException('This agent is already running');
    return this.runView(await this.enqueue(row, 'manual'));
  }

  async runs(user: User, workspace: Workspace, agentId: string, limit = 20): Promise<AgentRunView[]> {
    const row = await this.visible(user, workspace, agentId);
    const rows = await this.db
      .selectFrom('aiAgentRuns')
      .selectAll()
      .where('agentId', '=', row.id)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Math.max(limit, 1), 50))
      .execute();
    return Promise.all(rows.map((run) => this.runView(run)));
  }

  async run(user: User, workspace: Workspace, runId: string): Promise<AgentRunView> {
    const run = await this.db.selectFrom('aiAgentRuns').selectAll().where('id', '=', runId).where('workspaceId', '=', workspace.id).executeTakeFirst();
    if (!run) throw new NotFoundException('Run not found');
    await this.visible(user, workspace, run.agentId);
    return this.runView(run);
  }

  // ---- the clock ----------------------------------------------------------

  // Once a minute: the agents whose time has come are queued, each one
  // claimed by moving its next run forward so two servers never run it twice.
  // After a long stop an agent runs once, not once per missed day.
  async tick(now = new Date()): Promise<number> {
    await this.giveUpStaleRuns(now);
    const due = await this.db
      .selectFrom('aiAgents')
      .selectAll()
      .where('enabled', '=', true)
      .where('nextRunAt', 'is not', null)
      .where('nextRunAt', '<=', now)
      .orderBy('nextRunAt', 'asc')
      .limit(DUE_PER_TICK)
      .execute();
    let queued = 0;
    for (const agent of due) {
      let next: Date | null = null;
      try {
        next = nextRun(readSchedule(agent.schedule), now);
      } catch {
        next = null;
      }
      const claimed = await this.db
        .updateTable('aiAgents')
        .set({ nextRunAt: next })
        .where('id', '=', agent.id)
        // still due: whoever moves it forward first has it (comparing with
        // the value read would miss, the database keeps finer time than this)
        .where('nextRunAt', '<=', now)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;
      await this.enqueue(agent, 'schedule');
      queued++;
    }
    return queued;
  }

  private async giveUpStaleRuns(now = new Date()): Promise<void> {
    await this.db
      .updateTable('aiAgentRuns')
      .set({ status: 'failed', error: 'The run did not finish', finishedAt: now })
      .where('status', 'in', ['queued', 'running'])
      .where('createdAt', '<', new Date(now.getTime() - STALE_RUN_MS))
      .execute();
  }

  private async enqueue(agent: { id: string; workspaceId: string }, trigger: 'schedule' | 'manual') {
    const run = await this.db
      .insertInto('aiAgentRuns')
      .values({ agentId: agent.id, workspaceId: agent.workspaceId, status: 'queued', trigger })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.aiQueue.add(QueueJob.AI_AGENT_RUN, { runId: run.id }, { removeOnComplete: true, removeOnFail: true, attempts: 1 });
    return run;
  }

  // ---- one run ------------------------------------------------------------

  // The queue job: the model does the task and the result goes where the agent says.
  async process(data: { runId: string }): Promise<void> {
    const run = await this.db.selectFrom('aiAgentRuns').selectAll().where('id', '=', data.runId).executeTakeFirst();
    if (!run || run.status !== 'queued') return;
    const agent = await this.db.selectFrom('aiAgents').selectAll().where('id', '=', run.agentId).executeTakeFirst();
    if (!agent) return;
    const startedAt = new Date();
    await this.db.updateTable('aiAgentRuns').set({ status: 'running', startedAt }).where('id', '=', run.id).execute();

    const details: { suggestions: AgentRunView['suggestions']; created: PageBrief[]; steps: AgentRunView['steps'] } = { suggestions: [], created: [], steps: [] };
    let usage: Record<string, number> | null = null;
    try {
      const [user, workspace] = await Promise.all([
        this.userRepo.findById(agent.creatorId, agent.workspaceId),
        this.workspaceRepo.findById(agent.workspaceId),
      ]);
      if (!user || user.deletedAt || user.deactivatedAt || !workspace) throw new Error('The person who made this agent is no longer active');
      // a run is a question to the model: it counts against the person's day
      await this.usage.assertAllowed(workspace, user);
      const ai = ((workspace.settings as any)?.ai ?? {}) as Record<string, any>;
      const suggestEdits = ai.editsAsSuggestions !== false;
      const schedule = readSchedule(agent.schedule);
      const output = (agent.output ?? { kind: 'notify' }) as unknown as AgentOutput;
      const space = agent.spaceId
        ? await this.db.selectFrom('spaces').select(['id', 'name', 'slug']).where('id', '=', agent.spaceId).executeTakeFirst()
        : null;
      const target = output.kind === 'append' && output.pageId ? await this.pageRepo.findById(output.pageId) : null;

      const ctx: ToolContext = {
        user,
        workspace,
        readOnly: !agent.allowEdits || ai.chatReadOnly === true,
        suggestEdits,
        origin: 'agent',
        originLabel: agent.name,
        spaceId: agent.spaceId,
        since: agent.lastRunAt ? new Date(agent.lastRunAt as any) : null,
      };
      const tools = await this.tools.build(ctx);
      const { generateText, stepCountIs } = await import('ai');
      const model = await this.providers.languageModel(agent.workspaceId);
      const result: any = await generateText({
        model,
        system: agentPrompt({
          agentName: agent.name,
          workspaceName: workspace.name ?? 'the workspace',
          personName: user.name ?? 'the person',
          now: startedAt,
          timezone: schedule.timezone,
          lastRunAt: agent.lastRunAt ? new Date(agent.lastRunAt as any) : null,
          spaceName: space?.name ?? null,
          canWrite: !ctx.readOnly,
          suggestEdits,
          output: output.kind,
          targetTitle: target?.title ?? null,
        }),
        prompt: `Task:\n${agent.instructions}`,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        temperature: 0.3,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      usage = { promptTokens: Number(result.totalUsage?.inputTokens ?? result.usage?.inputTokens ?? 0), completionTokens: Number(result.totalUsage?.outputTokens ?? result.usage?.outputTokens ?? 0) };
      collect(result.steps ?? [], details);
      const text = String(result.text ?? '').trim();
      if (!text) throw new Error('The model gave no result');

      const landed = await this.deliver(user, workspace, agent, output, schedule, text, startedAt, suggestEdits, details);
      const finishedAt = new Date();
      await this.db
        .updateTable('aiAgentRuns')
        .set({ status: 'done', result: text.slice(0, MAX_RESULT_CHARS), pageId: landed?.id ?? null, details: details as any, usage: usage as any, finishedAt })
        .where('id', '=', run.id)
        .execute();
      await this.db
        .updateTable('aiAgents')
        .set({ lastRunAt: startedAt, lastStatus: 'done', lastError: null, failures: 0, updatedAt: finishedAt })
        .where('id', '=', agent.id)
        .execute();
      await this.notifications
        .create({
          userId: agent.creatorId,
          workspaceId: agent.workspaceId,
          type: NotificationType.AI_AGENT_RUN_COMPLETED,
          actorId: null,
          pageId: landed?.id ?? null,
          spaceId: landed?.spaceId ?? null,
          data: { agentId: agent.id, agentName: agent.name, runId: run.id, summary: firstLine(text), suggestions: details.suggestions.length },
        } as any)
        .catch(() => undefined);
    } catch (err: any) {
      const message = String(err?.response?.message ?? err?.message ?? 'The run failed').slice(0, 500);
      this.logger.warn(`agent ${agent.id} run ${run.id} failed: ${message}`);
      const finishedAt = new Date();
      await this.db
        .updateTable('aiAgentRuns')
        .set({ status: 'failed', error: message, details: details as any, usage: usage as any, finishedAt })
        .where('id', '=', run.id)
        .execute();
      const failures = Number(agent.failures ?? 0) + 1;
      const pause = failures >= FAILURES_TO_PAUSE;
      await this.db
        .updateTable('aiAgents')
        .set({ lastRunAt: startedAt, lastStatus: 'failed', lastError: message, failures, updatedAt: finishedAt, ...(pause ? { enabled: false, nextRunAt: null } : {}) })
        .where('id', '=', agent.id)
        .execute();
      await this.notifications
        .create({
          userId: agent.creatorId,
          workspaceId: agent.workspaceId,
          type: NotificationType.AI_AGENT_RUN_FAILED,
          actorId: null,
          data: { agentId: agent.id, agentName: agent.name, runId: run.id, error: message, paused: pause },
        } as any)
        .catch(() => undefined);
    }
  }

  // Where the result goes. Returns the page it landed on, when there is one.
  private async deliver(
    user: User,
    workspace: Workspace,
    agent: { id: string; name: string },
    output: AgentOutput,
    schedule: AgentSchedule,
    text: string,
    at: Date,
    suggestEdits: boolean,
    details: { suggestions: AgentRunView['suggestions']; created: PageBrief[] },
  ): Promise<{ id: string; spaceId: string } | null> {
    const day = dayLabel(at, schedule.timezone);
    if (output.kind === 'page' && output.spaceId) {
      if (output.parentPageId) {
        const parent = await this.pageRepo.findById(output.parentPageId);
        if (!parent || parent.deletedAt || parent.spaceId !== output.spaceId) throw new Error('The page that holds the results is gone');
        await this.pageAccess.validateCanEdit(parent, user);
      } else {
        const ability = await this.spaceAbility.createForUser(user, output.spaceId);
        if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new Error('You can no longer create pages in the space of the results');
      }
      const page = await this.pageService.create(user.id, workspace.id, {
        spaceId: output.spaceId,
        title: `${agent.name} · ${day}`,
        content: text,
        format: 'markdown',
        parentPageId: output.parentPageId ?? undefined,
      } as any);
      details.created.unshift(await this.brief(page));
      return { id: page.id, spaceId: page.spaceId };
    }
    if (output.kind === 'append' && output.pageId) {
      const page = await this.pageRepo.findById(output.pageId, { includeContent: true });
      if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw new Error('The page the results are added to is gone');
      const section = `## ${day}\n\n${text}`;
      if (suggestEdits) {
        // the page grows only when someone accepts the addition
        const piece = await this.pageService.parseProsemirrorContent(section, 'markdown');
        const suggestion = await this.suggestions.create(
          user,
          workspace.id,
          { pageId: page.id, content: piece, note: `${agent.name} · ${day}` },
          { origin: 'agent', label: agent.name, operation: 'append' },
        );
        const brief = await this.brief(page);
        details.suggestions.unshift({ suggestionId: suggestion.id, title: brief.title, reviewUrl: `${brief.url}?suggestion=${suggestion.id}` });
      } else {
        await this.pageAccess.validateCanEdit(page, user);
        await this.pageService.update(page, { pageId: page.id, content: section, format: 'markdown', operation: 'append' } as any, user);
      }
      return { id: page.id, spaceId: page.spaceId };
    }
    return null;
  }

  // ---- checks and views ---------------------------------------------------

  private async assertMayUse(user: User, workspace: Workspace): Promise<void> {
    const status = await this.usage.status(workspace, user);
    if (!status.allowed) throw new ForbiddenException('AI is not available for your account');
    if (!(await this.settings.generationChoice(workspace.id).catch(() => null))) {
      throw new BadRequestException('No AI model is configured. An admin can set one under Settings > AI.');
    }
  }

  private async visible(user: User, workspace: Workspace, agentId: string) {
    const row = await this.db.selectFrom('aiAgents').selectAll().where('id', '=', agentId).where('workspaceId', '=', workspace.id).executeTakeFirst();
    if (!row || (row.creatorId !== user.id && !isAdmin(user))) throw new NotFoundException('Agent not found');
    return row;
  }

  private async readSpace(user: User, workspace: Workspace, raw: unknown): Promise<string | null> {
    if (raw === null || raw === undefined || raw === '') return null;
    const spaceId = String(raw);
    const member = await this.spaceMemberRepo.getUserSpaceIds(user.id);
    const space = await this.db.selectFrom('spaces').select('id').where('id', '=', spaceId).where('workspaceId', '=', workspace.id).executeTakeFirst();
    if (!space || !member.includes(spaceId)) throw new BadRequestException('You do not have access to that space');
    return spaceId;
  }

  private async readOutput(user: User, workspace: Workspace, raw: unknown, scope: string | null): Promise<AgentOutput> {
    const input = (raw ?? {}) as Record<string, unknown>;
    if (input.kind === 'notify') return { kind: 'notify' };
    if (input.kind === 'page') {
      const spaceId = await this.readSpace(user, workspace, input.spaceId ?? scope);
      if (!spaceId) throw new BadRequestException('Pick the space where the pages go');
      let parentPageId: string | null = null;
      if (input.parentPageId) {
        const parent = await this.pageRepo.findById(String(input.parentPageId));
        if (!parent || parent.deletedAt || parent.workspaceId !== workspace.id || parent.spaceId !== spaceId) {
          throw new BadRequestException('The parent page is not in that space');
        }
        await this.pageAccess.validateCanEdit(parent, user);
        parentPageId = parent.id;
      } else {
        const ability = await this.spaceAbility.createForUser(user, spaceId);
        if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new ForbiddenException('You cannot create pages in that space');
      }
      return { kind: 'page', spaceId, parentPageId };
    }
    if (input.kind === 'append') {
      const page = input.pageId ? await this.pageRepo.findById(String(input.pageId)) : null;
      if (!page || page.deletedAt || page.workspaceId !== workspace.id) throw new BadRequestException('Pick the page the results are added to');
      if (page.isBase) throw new BadRequestException('Results cannot be added to a base');
      await this.pageAccess.validateCanView(page, user);
      return { kind: 'append', pageId: page.id };
    }
    throw new BadRequestException('The result goes to a new page, to a page that grows, or to a notification');
  }

  private async brief(page: { id: string; title: string | null; slugId: string; spaceId: string }): Promise<PageBrief> {
    const space = await this.db.selectFrom('spaces').select('slug').where('id', '=', page.spaceId).executeTakeFirst();
    return { id: page.id, title: page.title || 'Untitled', url: pageUrl(space?.slug ?? null, page.slugId) };
  }

  private async briefOf(pageId: string | null | undefined): Promise<PageBrief | null> {
    if (!pageId) return null;
    const page = await this.db.selectFrom('pages').select(['id', 'title', 'slugId', 'spaceId']).where('id', '=', pageId).where('deletedAt', 'is', null).executeTakeFirst();
    return page ? this.brief(page) : null;
  }

  private async view(row: any, user: User): Promise<AgentView> {
    const output = (row.output ?? { kind: 'notify' }) as AgentOutput;
    const spaceIds = [row.spaceId, output.spaceId].filter(Boolean) as string[];
    const spaces = spaceIds.length
      ? await this.db.selectFrom('spaces').select(['id', 'name', 'slug']).where('id', 'in', spaceIds).execute()
      : [];
    const creator = await this.db.selectFrom('users').select(['id', 'name', 'avatarUrl']).where('id', '=', row.creatorId).executeTakeFirst();
    return {
      id: row.id,
      name: row.name,
      instructions: row.instructions,
      spaceId: row.spaceId ?? null,
      space: spaces.find((s) => s.id === row.spaceId) ?? null,
      schedule: row.schedule as AgentSchedule,
      output,
      outputPage: await this.briefOf(output.kind === 'append' ? output.pageId : output.parentPageId),
      outputSpace: spaces.find((s) => s.id === output.spaceId) ?? null,
      allowEdits: row.allowEdits === true,
      enabled: row.enabled === true,
      nextRunAt: iso(row.nextRunAt),
      lastRunAt: iso(row.lastRunAt),
      lastStatus: row.lastStatus ?? null,
      lastError: row.lastError ?? null,
      creator: creator ? { id: creator.id, name: creator.name ?? '', avatarUrl: creator.avatarUrl ?? null } : null,
      mine: row.creatorId === user.id,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    };
  }

  private async runView(run: any): Promise<AgentRunView> {
    const details = (run.details ?? {}) as Partial<{ suggestions: AgentRunView['suggestions']; created: PageBrief[]; steps: AgentRunView['steps'] }>;
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      trigger: run.trigger,
      result: run.result ?? null,
      error: run.error ?? null,
      page: await this.briefOf(run.pageId),
      suggestions: Array.isArray(details.suggestions) ? details.suggestions : [],
      created: Array.isArray(details.created) ? details.created : [],
      steps: Array.isArray(details.steps) ? details.steps : [],
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      createdAt: iso(run.createdAt)!,
    };
  }
}

function isAdmin(user: User): boolean {
  return user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new BadRequestException('Give the agent a name');
  if (name.length > MAX_NAME) throw new BadRequestException(`The name is at most ${MAX_NAME} characters`);
  return name;
}

function readInstructions(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text.length < MIN_INSTRUCTIONS) throw new BadRequestException('Say what the agent should do');
  if (text.length > MAX_INSTRUCTIONS) throw new BadRequestException(`The task is at most ${MAX_INSTRUCTIONS} characters`);
  return text;
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/[#*_`>]/g, '').trim())
    .find(Boolean);
  return (line ?? '').slice(0, 200);
}

// What the run did with its tools: the steps in order, the suggestions it
// filed and the pages it made.
export function collect(
  steps: any[],
  into: { suggestions: AgentRunView['suggestions']; created: PageBrief[]; steps: AgentRunView['steps'] },
): void {
  for (const step of steps) {
    const results = new Map<string, any>();
    for (const r of step?.toolResults ?? []) results.set(r.toolCallId, r.output ?? r.result);
    for (const call of step?.toolCalls ?? []) {
      const args = (call.input ?? call.args ?? {}) as Record<string, unknown>;
      const detail = typeof args.query === 'string' ? args.query : typeof args.title === 'string' ? args.title : typeof args.pageId === 'string' ? args.pageId : '';
      const out = results.get(call.toolCallId);
      const failed = out && typeof out === 'object' && typeof out.error === 'string';
      into.steps.push({ name: String(call.toolName), detail: (failed ? `${detail} (${out.error})` : detail).slice(0, 200) });
      if (!out || typeof out !== 'object') continue;
      if (out.proposed === true && typeof out.suggestionId === 'string') {
        into.suggestions.push({ suggestionId: out.suggestionId, title: String(out.title ?? ''), reviewUrl: String(out.reviewUrl ?? '') });
      }
      if (out.created === true && typeof out.url === 'string') {
        into.created.push({ id: String(out.id ?? ''), title: String(out.title ?? ''), url: out.url });
      }
    }
  }
}

export function agentPrompt(input: {
  agentName: string;
  workspaceName: string;
  personName: string;
  now: Date;
  timezone: string;
  lastRunAt: Date | null;
  spaceName: string | null;
  canWrite: boolean;
  suggestEdits: boolean;
  output: AgentOutput['kind'];
  targetTitle: string | null;
}): string {
  const p = partsIn(input.now, input.timezone);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.weekday] ?? '';
  const today = `${weekday}, ${dayLabel(input.now, input.timezone)}`;
  const lines = [
    `You are "${input.agentName}", a scheduled agent of "${input.workspaceName}", a team wiki. You run on your own, on a schedule, for ${input.personName}.`,
    'Nobody is there while you work: never ask a question or wait for an answer. Do the task with what you can find, and say plainly what you could not do.',
    `Today is ${today} (${input.timezone}). ` +
      (input.lastRunAt ? `Your previous run was on ${dayLabel(input.lastRunAt, input.timezone)}; "since last time" means since then.` : 'This is your first run; "since last time" means the last seven days.'),
    input.spaceName
      ? `You work only inside the space "${input.spaceName}"; nothing outside it exists for you.`
      : `You see every space ${input.personName} can see.`,
    'You have tools to list spaces, list the pages changed since a date (list_changed_pages), list pages whose verification ran out (list_pages_to_verify), search and read pages, and read bases. ' +
      'Read a page before you say what it says; never guess.',
    !input.canWrite
      ? 'You cannot create or change pages or rows yourself; your result is delivered for you.'
      : input.suggestEdits
        ? 'You may create pages and add rows when the task asks for it. You never change an existing page directly: file the change with suggest_page_edit; a person will accept or reject it.'
        : 'You may create and change pages and rows when the task asks for it; change only what the task names.',
    input.output === 'page'
      ? 'Your final answer is the result of this run and becomes a new page. Do not create that page yourself.'
      : input.output === 'append'
        ? `Your final answer is the result of this run and is added under today's date to the page "${input.targetTitle ?? 'chosen for it'}". Do not edit that page yourself.`
        : `Your final answer is the result of this run and is sent to ${input.personName} as a notification.`,
    'Write the result in Markdown, in the language of the task, complete on its own: no greeting, no talk about tools or about being an agent. ' +
      'Link every page you mention with its url as a Markdown link, for example [Title](/s/space/p/slugId). If there is nothing to report, say so in one line.',
  ];
  return lines.join('\n');
}
