import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import type { MultipartFile } from '@fastify/multipart';
import type { ModelMessage } from 'ai';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { AiChat, AiChatMessage, Attachment, User, Workspace } from '@docmost/db/types/entity.types';
import { StorageService } from '../../../integrations/storage/storage.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { AttachmentType } from '../../attachment/attachment.constants';
import { getAttachmentFolderPath, prepareFile } from '../../attachment/attachment.utils';
import { AttachmentIndexService } from '../../attachment/services/attachment-index.service';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import { AiProviderService } from '../ai-provider.service';
import { AiGenerateService } from '../ai-generate.service';
import { AiChatRepo } from './ai-chat.repo';
import { AiChatToolsService, pageUrl } from './ai-chat-tools.service';
import { AiMcpToolsService } from '../mcp-client/ai-mcp-tools.service';
import { AiSkillService, SkillView } from '../skills/ai-skill.service';
import {
  CHAT_FILE_EXTENSIONS,
  CHAT_IMAGE_EXTENSIONS,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_OUTPUT_TOKENS,
  MAX_CONTEXT_PAGE_CHARS,
  MAX_CONTEXT_TOTAL_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_TITLE_CHARS,
  MAX_TOOL_STEPS,
} from './ai-chat.constants';

export type ChatStreamEvent =
  | { type: 'chat_created'; chatId: string }
  | { type: 'content'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'done'; messageId: string; usage?: Record<string, number> }
  | { type: 'error'; message: string; code?: string; retryable?: boolean };

export interface SendInput {
  chatId?: string;
  content: string;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  // a skill (by id or slug) whose instructions steer this turn
  skillId?: string;
  // server-side only: the stored user message's extra metadata, for turns
  // the UI started (an approved or denied tool call)
  internalMetadata?: Record<string, unknown>;
}

export interface ChatAttachmentView {
  id: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string;
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

interface ChatOptions {
  readOnly: boolean;
  knowledgeOnly: boolean;
  // changes to existing pages go as suggestions (on unless turned off)
  suggestEdits: boolean;
}

// The AI chat: a conversation per user with the workspace's pages at hand
// through tools, streamed as typed events. Everything the model reads or
// writes goes through the asking user's permissions.
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly chats: AiChatRepo,
    private readonly tools: AiChatToolsService,
    private readonly mcpTools: AiMcpToolsService,
    private readonly skills: AiSkillService,
    private readonly providers: AiProviderService,
    private readonly generate: AiGenerateService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly attachmentIndex: AttachmentIndexService,
    private readonly storage: StorageService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private readonly attachmentQueue: Queue,
  ) {}

  // ---- chats --------------------------------------------------------------

  async create(user: User, workspace: Workspace): Promise<AiChat> {
    return this.chats.createChat({ workspaceId: workspace.id, creatorId: user.id, title: null });
  }

  async list(user: User, workspace: Workspace, pagination: PaginationOptions) {
    return this.chats.listChats(user.id, workspace.id, pagination);
  }

  async search(user: User, workspace: Workspace, query: string): Promise<AiChat[]> {
    return this.chats.searchChats(user.id, workspace.id, query);
  }

  async info(user: User, workspace: Workspace, chatId: string): Promise<{ chat: AiChat; messages: AiChatMessage[] }> {
    const chat = await this.ownedChat(user, workspace, chatId);
    const messages = await this.chats.messages(chat.id);
    return { chat, messages };
  }

  async rename(user: User, workspace: Workspace, chatId: string, title: string): Promise<AiChat> {
    const chat = await this.ownedChat(user, workspace, chatId);
    const trimmed = title.trim();
    if (!trimmed) throw new BadRequestException('The title cannot be empty');
    return (await this.chats.updateChat(chat.id, { title: trimmed })) ?? chat;
  }

  async delete(user: User, workspace: Workspace, chatId: string) {
    const chat = await this.ownedChat(user, workspace, chatId);
    await this.chats.deleteChat(chat.id);
    await this.attachmentQueue.add(
      QueueJob.DELETE_AI_CHAT_ATTACHMENTS,
      { aiChatId: chat.id },
      { removeOnComplete: true, removeOnFail: true },
    );
  }

  // ---- files --------------------------------------------------------------

  async upload(
    user: User,
    workspace: Workspace,
    filePromise: Promise<MultipartFile>,
    chatId?: string,
  ): Promise<ChatAttachmentView> {
    if (chatId) await this.ownedChat(user, workspace, chatId);
    await this.purgeOrphanUploads(user, workspace);
    const prepared = await prepareFile(filePromise);
    const ext = prepared.fileExtension.toLowerCase();
    if (!CHAT_FILE_EXTENSIONS.includes(ext)) {
      throw new BadRequestException(`Unsupported file type; use ${CHAT_FILE_EXTENSIONS.join(', ')}`);
    }
    if (!prepared.buffer) {
      throw new BadRequestException('Empty upload');
    }
    if (prepared.fileSize > MAX_CHAT_FILE_BYTES) {
      throw new PayloadTooLargeException('Files up to 20 MB can be attached');
    }

    const id = randomUUID();
    const filePath = `${getAttachmentFolderPath(AttachmentType.Chat, workspace.id)}/${id}${ext}`;
    await this.storage.upload(filePath, prepared.buffer);

    let textContent: string | null = null;
    if (!CHAT_IMAGE_EXTENSIONS.includes(ext)) {
      try {
        textContent = (await this.attachmentIndex.extractTextFromBuffer(prepared.buffer, ext)) || null;
      } catch (err: any) {
        this.logger.debug(`chat file text extraction failed: ${err?.message}`);
      }
    }

    const attachment = await this.attachmentRepo.insertAttachment({
      id,
      type: AttachmentType.Chat,
      filePath,
      fileName: prepared.fileName,
      fileSize: prepared.fileSize,
      fileExt: ext,
      mimeType: prepared.mimeType,
      creatorId: user.id,
      workspaceId: workspace.id,
      aiChatId: chatId ?? null,
      textContent,
      indexedAt: new Date(),
    } as any);
    return viewOf(attachment);
  }

  // Files uploaded for a message that was never sent have no chat to be
  // deleted with; this user's day-old ones go when they upload again.
  private async purgeOrphanUploads(user: User, workspace: Workspace) {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const orphans = await this.db
        .selectFrom('attachments')
        .select(['id', 'filePath'])
        .where('workspaceId', '=', workspace.id)
        .where('creatorId', '=', user.id)
        .where('type', '=', AttachmentType.Chat)
        .where('aiChatId', 'is', null)
        .where('createdAt', '<', cutoff)
        .limit(50)
        .execute();
      for (const orphan of orphans) {
        await this.storage.delete(orphan.filePath).catch(() => undefined);
        await this.attachmentRepo.deleteAttachmentById(orphan.id);
      }
    } catch (err: any) {
      this.logger.debug(`orphan chat upload purge failed: ${err?.message}`);
    }
  }

  // ---- the conversation ---------------------------------------------------

  // Run before the response turns into an event stream, so a bad request
  // still gets a normal error status.
  async validateSend(user: User, workspace: Workspace, input: SendInput): Promise<void> {
    const content = input.content?.trim() ?? '';
    const attachments = await this.ownedAttachments(user, workspace, input.attachmentIds ?? []);
    if (!content && attachments.length === 0) {
      throw new BadRequestException('Write a message first');
    }
    if (input.chatId) await this.ownedChat(user, workspace, input.chatId);
    if (input.skillId && !(await this.skills.usable(user, workspace, input.skillId))) {
      throw new BadRequestException('That skill is not available');
    }
  }

  async *send(
    user: User,
    workspace: Workspace,
    input: SendInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const content = input.content?.trim() ?? '';
    const attachments = await this.ownedAttachments(user, workspace, input.attachmentIds ?? []);
    if (!content && attachments.length === 0) {
      throw new BadRequestException('Write a message first');
    }
    const options = await this.options(workspace.id);

    let chat: AiChat;
    if (input.chatId) {
      chat = await this.ownedChat(user, workspace, input.chatId);
    } else {
      chat = await this.chats.createChat({
        workspaceId: workspace.id,
        creatorId: user.id,
        title: titleFrom(content) || (attachments[0]?.fileName ?? null),
      });
      yield { type: 'chat_created', chatId: chat.id };
    }
    if (attachments.length) {
      await this.attachmentRepo.claimAttachmentsForChat(
        attachments.map((a) => a.id),
        chat.id,
        user.id,
        workspace.id,
      );
    }

    // Pages the user pointed at travel inside the stored message, in a block
    // the client hides, so the history keeps what the model saw.
    const references = await this.referencedPages(user, workspace, [
      ...(input.contextPageId ? [input.contextPageId] : []),
      ...(input.mentionedPageIds ?? []),
    ]);
    const storedContent = references.block ? `${content}\n\n${references.block}` : content;
    const metadata: Record<string, unknown> = { ...(input.internalMetadata ?? {}) };
    let skill: SkillView | null = null;
    if (input.skillId) {
      skill = await this.skills.usable(user, workspace, input.skillId);
      if (!skill) throw new BadRequestException('That skill is not available');
      metadata.skill = { id: skill.id, name: skill.name, slug: skill.slug };
      await this.skills.markUsed(skill.id);
    }
    if (input.mentionedPageIds?.length) metadata.mentionedPageIds = input.mentionedPageIds;
    if (input.contextPageId) metadata.contextPageId = input.contextPageId;
    if (attachments.length) {
      metadata.attachments = attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileExt: a.fileExt.replace(/^\./, ''),
      }));
    }
    const history = await this.chats.messages(chat.id);
    await this.chats.insertMessage({
      chatId: chat.id,
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      content: storedContent,
      metadata: Object.keys(metadata).length ? metadata : null,
    });

    const messages = this.historyToMessages(history);
    messages.push(await this.userMessage(storedContent, attachments));

    const { streamText, stepCountIs } = await import('ai');
    const model = await this.providers.languageModel(workspace.id);
    const tools = {
      ...(await this.tools.build({ user, workspace, readOnly: options.readOnly, suggestEdits: options.suggestEdits, origin: 'chat' })),
      ...(await this.mcpTools.build(user, workspace, chat.id).catch((err) => {
        this.logger.debug(`MCP tools unavailable: ${err?.message}`);
        return {};
      })),
    };

    let text = '';
    const toolCalls: ToolCallRecord[] = [];
    let usage: Record<string, number> | undefined;
    let failed: string | null = null;

    try {
      const result = streamText({
        model,
        system: systemPrompt(workspace, user, options, Object.keys(tools).length === 0, skill),
        messages,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        temperature: 0.3,
        maxOutputTokens: MAX_CHAT_OUTPUT_TOKENS,
        abortSignal: signal,
      });
      for await (const part of result.fullStream as AsyncIterable<any>) {
        switch (part.type) {
          case 'text-delta': {
            const delta: string = part.text ?? part.textDelta ?? '';
            if (!delta) break;
            text += delta;
            yield { type: 'content', text: delta };
            break;
          }
          case 'tool-call': {
            const call: ToolCallRecord = {
              id: part.toolCallId,
              name: part.toolName,
              args: (part.input ?? part.args ?? {}) as Record<string, unknown>,
            };
            toolCalls.push(call);
            yield { type: 'tool_call', id: call.id, name: call.name, args: call.args };
            break;
          }
          case 'tool-result': {
            const output = part.output ?? part.result;
            const call = toolCalls.find((c) => c.id === part.toolCallId);
            if (call) call.result = output;
            yield { type: 'tool_result', id: part.toolCallId, result: output };
            break;
          }
          case 'tool-error': {
            const output = { error: String(part.error?.message ?? part.error ?? 'Tool failed') };
            const call = toolCalls.find((c) => c.id === part.toolCallId);
            if (call) call.result = output;
            yield { type: 'tool_result', id: part.toolCallId, result: output };
            break;
          }
          case 'finish': {
            const total = part.totalUsage ?? part.usage;
            if (total) {
              usage = {
                promptTokens: Number(total.inputTokens ?? total.promptTokens ?? 0),
                completionTokens: Number(total.outputTokens ?? total.completionTokens ?? 0),
                totalTokens: Number(
                  total.totalTokens ??
                    Number(total.inputTokens ?? 0) + Number(total.outputTokens ?? 0),
                ),
              };
            }
            break;
          }
          case 'error':
            throw part.error ?? new Error('The model stream failed');
          default:
            break;
        }
      }
    } catch (err: any) {
      if (signal?.aborted) {
        await this.persistAssistant(chat, workspace, text, toolCalls, usage, true);
        return;
      }
      failed = this.generate.explain(err);
    }

    if (failed) {
      // Keep what the model managed so the history makes sense on reload.
      await this.persistAssistant(chat, workspace, text, toolCalls, usage, false, failed);
      yield { type: 'error', message: failed, retryable: true };
      return;
    }

    const saved = await this.persistAssistant(chat, workspace, text, toolCalls, usage, false);
    yield { type: 'done', messageId: saved?.id ?? randomUUID(), usage };
  }

  // ---- internals ----------------------------------------------------------

  private async ownedChat(user: User, workspace: Workspace, chatId: string): Promise<AiChat> {
    const chat = await this.chats.findChat(chatId, workspace.id);
    if (!chat || chat.creatorId !== user.id) {
      throw new NotFoundException('Chat not found');
    }
    return chat;
  }

  private async options(workspaceId: string): Promise<ChatOptions> {
    const ws = await this.workspaceRepo.findById(workspaceId);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    return {
      readOnly: ai.chatReadOnly === true,
      knowledgeOnly: ai.chatWorkspaceKnowledgeOnly === true,
      suggestEdits: ai.editsAsSuggestions !== false,
    };
  }

  private async ownedAttachments(user: User, workspace: Workspace, ids: string[]): Promise<Attachment[]> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return [];
    if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BadRequestException(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`);
    }
    // Straight from the table: the repo's base fields leave text_content out.
    const rows = (await this.db
      .selectFrom('attachments')
      .select([
        'id',
        'workspaceId',
        'creatorId',
        'type',
        'fileName',
        'fileExt',
        'filePath',
        'mimeType',
        'fileSize',
        'textContent',
        'aiChatId',
      ])
      .where('id', 'in', unique)
      .where('deletedAt', 'is', null)
      .execute()) as unknown as Attachment[];
    const mine = rows.filter(
      (a) => a.workspaceId === workspace.id && a.creatorId === user.id && a.type === AttachmentType.Chat,
    );
    if (mine.length !== unique.length) {
      throw new BadRequestException('One of the attached files is not available');
    }
    return mine;
  }

  // Mentioned and context pages the user may read, as a Markdown block.
  private async referencedPages(
    user: User,
    workspace: Workspace,
    pageIds: string[],
  ): Promise<{ block: string | null }> {
    const unique = Array.from(new Set(pageIds)).slice(0, 10);
    if (unique.length === 0) return { block: null };
    const parts: string[] = [];
    let budget = MAX_CONTEXT_TOTAL_CHARS;
    for (const pageId of unique) {
      const page = await this.pageRepo.findById(pageId, { includeContent: true, includeTextContent: true });
      if (!page || page.deletedAt || page.workspaceId !== workspace.id) continue;
      try {
        await this.pageAccess.validateCanView(page, user);
      } catch {
        continue;
      }
      let markdown = '';
      try {
        markdown = page.content ? jsonToMarkdown(page.content as any) : (page.textContent ?? '');
      } catch {
        markdown = page.textContent ?? '';
      }
      const limit = Math.min(MAX_CONTEXT_PAGE_CHARS, budget);
      if (limit <= 0) break;
      const body = markdown.length > limit ? `${markdown.slice(0, limit)}\n[truncated]` : markdown;
      budget -= body.length;
      const space = await this.spaceSlug(page.spaceId);
      parts.push(
        `<page id="${page.id}" title="${escapeAttr(page.title || 'Untitled')}" url="${pageUrl(space, page.slugId)}">\n${body}\n</page>`,
      );
    }
    if (parts.length === 0) return { block: null };
    return { block: `<referenced_pages>\n${parts.join('\n')}\n</referenced_pages>` };
  }

  private async spaceSlug(spaceId: string): Promise<string | null> {
    const space = await this.db
      .selectFrom('spaces')
      .select('slug')
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return space?.slug ?? null;
  }

  private historyToMessages(history: AiChatMessage[]): ModelMessage[] {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    const out: ModelMessage[] = [];
    for (const message of recent) {
      if (message.role === 'user') {
        out.push({ role: 'user', content: message.content ?? '' });
      } else if (message.role === 'assistant') {
        const calls = Array.isArray(message.toolCalls)
          ? (message.toolCalls as unknown as ToolCallRecord[])
          : [];
        const note = calls.length
          ? `\n\n[Earlier tools used: ${calls.map((c) => c.name).join(', ')}]`
          : '';
        const body = (message.content ?? '') + note;
        if (body.trim()) out.push({ role: 'assistant', content: body });
      }
    }
    return out;
  }

  // The new user turn: text, attached file texts, and images as image parts.
  private async userMessage(content: string, attachments: Attachment[]): Promise<ModelMessage> {
    if (attachments.length === 0) return { role: 'user', content };
    const parts: any[] = [];
    const fileTexts: string[] = [];
    for (const attachment of attachments) {
      const ext = (attachment.fileExt ?? '').toLowerCase();
      if (CHAT_IMAGE_EXTENSIONS.includes(ext)) {
        try {
          const image = await this.storage.read(attachment.filePath);
          parts.push({ type: 'image', image, mediaType: attachment.mimeType ?? undefined });
        } catch (err: any) {
          this.logger.debug(`could not read chat image ${attachment.id}: ${err?.message}`);
        }
      } else {
        const text = (attachment.textContent ?? '').trim();
        fileTexts.push(
          `<file name="${escapeAttr(attachment.fileName)}">\n${
            text ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : '[no readable text in this file]'
          }\n</file>`,
        );
      }
    }
    const text = [content, fileTexts.length ? `<attached_files>\n${fileTexts.join('\n')}\n</attached_files>` : '']
      .filter(Boolean)
      .join('\n\n');
    parts.unshift({ type: 'text', text: text || 'See the attached files.' });
    return { role: 'user', content: parts };
  }

  private async persistAssistant(
    chat: AiChat,
    workspace: Workspace,
    text: string,
    toolCalls: ToolCallRecord[],
    usage: Record<string, number> | undefined,
    stopped: boolean,
    error?: string,
  ): Promise<AiChatMessage | null> {
    if (!text && toolCalls.length === 0 && !error) return null;
    const metadata: Record<string, unknown> = {};
    if (usage) metadata.tokenUsage = usage;
    if (stopped) metadata.stopped = true;
    if (error) metadata.error = error;
    const saved = await this.chats.insertMessage({
      chatId: chat.id,
      workspaceId: workspace.id,
      userId: null,
      role: 'assistant',
      content: text || null,
      toolCalls: toolCalls.length ? toolCalls : null,
      metadata: Object.keys(metadata).length ? metadata : null,
    });
    await this.chats.touchChat(chat.id);
    return saved;
  }
}

function systemPrompt(workspace: Workspace, user: User, options: ChatOptions, noTools: boolean, skill: SkillView | null = null): string {
  const lines = [
    `You are the assistant built into "${workspace.name}", a team wiki. You talk with ${user.name}.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    noTools
      ? ''
      : 'You have tools to list spaces, search pages, read a page and, if allowed, create or update pages. ' +
        'When a question may be answered by the wiki, search first and read the page before answering; ' +
        'never guess page contents. Prefer the pages referenced in the message when there are any.',
    'When you use a page, link it with its url as a Markdown link, for example [Title](/s/space/p/slugId).',
    options.readOnly
      ? 'You cannot create or change pages in this workspace; say so if asked.'
      : options.suggestEdits
        ? 'Create pages only when the user clearly asks for it. You never change an existing page yourself: when the user asks for an edit, file it with suggest_page_edit, ' +
          'then say that the change waits for review on the page (it is not applied yet) and link its reviewUrl.'
        : 'Create or change pages only when the user clearly asks for it, and confirm what you did with a link.',
    options.knowledgeOnly
      ? 'Answer only from the workspace content you find or that is given to you. If it is not there, say that the workspace has nothing on it; do not use outside knowledge.'
      : 'Use the workspace content when it is relevant; otherwise answer from general knowledge and say so.',
    'Answer in the language the user writes in. Use Markdown. Be concise and concrete.',
    noTools
      ? ''
      : 'Tools named mcp__… belong to outside services the user connected; use them when the request is about those services. A tool that answers with pendingApproval is waiting for the user: stop, say what it would do, and wait.',
    skill ? `\n## Skill: ${skill.name}\nFollow these instructions for this conversation turn:\n${skill.instructions}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function titleFrom(content: string): string | null {
  const line = content
    .split('\n')
    .map((l) => l.replace(/[#*_`>]/g, '').trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : line;
}

function viewOf(attachment: Attachment): ChatAttachmentView {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    fileExt: (attachment.fileExt ?? '').replace(/^\./, ''),
    fileSize: Number(attachment.fileSize ?? 0),
    mimeType: attachment.mimeType ?? 'application/octet-stream',
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
