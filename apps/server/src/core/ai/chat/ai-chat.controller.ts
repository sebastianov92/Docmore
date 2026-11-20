import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiChatService } from './ai-chat.service';
import { MAX_CHAT_FILE_BYTES } from './ai-chat.constants';
import { ChatIdDto, ListChatsDto, SearchChatsDto, SendMessageDto, ToolApprovalDto, UpdateChatDto } from './dto/ai-chat.dto';
import { AiUsageService } from '../ai-usage.service';
import { AiMcpToolsService } from '../mcp-client/ai-mcp-tools.service';
import { ChatStreamEvent } from './ai-chat.service';

@UseGuards(JwtAuthGuard)
@Controller('ai/chats')
export class AiChatController {
  constructor(
    private readonly chats: AiChatService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly usage: AiUsageService,
    private readonly mcpTools: AiMcpToolsService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@Body() dto: ListChatsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    return this.chats.list(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    return this.chats.create(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@Body() dto: ChatIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    return this.chats.info(user, workspace, dto.chatId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() dto: UpdateChatDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    return this.chats.rename(user, workspace, dto.chatId, dto.title);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(@Body() dto: ChatIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    await this.chats.delete(user, workspace, dto.chatId);
    return {};
  }

  @HttpCode(HttpStatus.OK)
  @Post('search')
  async search(@Body() dto: SearchChatsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    return this.chats.search(user, workspace, dto.query);
  }

  // multipart: "file", optional "chatId" field.
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  async upload(@Req() req: FastifyRequest, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    let file: any = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_CHAT_FILE_BYTES, fields: 3, files: 1 } });
    } catch (err: any) {
      if (err?.statusCode === 413) {
        throw new PayloadTooLargeException('Files up to 20 MB can be attached');
      }
    }
    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }
    const chatIdField = file.fields?.chatId;
    const chatId: string | undefined =
      (Array.isArray(chatIdField) ? chatIdField[0]?.value : chatIdField?.value) || undefined;
    return this.chats.upload(user, workspace, Promise.resolve(file), chatId);
  }

  // Server-sent events, one typed event per line: chat_created, content,
  // tool_call, tool_result, done or error, then [DONE].
  @Post('send')
  async send(
    @Body() dto: SendMessageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertChatOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    await this.chats.validateSend(user, workspace, dto);
    const controller = this.openStream(req, res);
    await this.pipe(res, this.chats.send(user, workspace, dto, controller.signal));
  }

  // The person approved a parked MCP tool call: it runs now and the model
  // continues the conversation with its result, streamed like any turn.
  @Post('tools/approve')
  async approveTool(
    @Body() dto: ToolApprovalDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertChatOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    let outcome: { chatId: string; server: string; tool: string; args: unknown; result: unknown };
    try {
      outcome = await this.mcpTools.approve(user, workspace, dto.approvalId);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Could not run the tool');
    }
    const controller = this.openStream(req, res);
    const resultText = JSON.stringify(outcome.result ?? null).slice(0, 20_000);
    await this.pipe(
      res,
      this.chats.send(
        user,
        workspace,
        {
          chatId: outcome.chatId,
          content: `I approved the "${outcome.tool}" call on ${outcome.server}. It already ran once; its result:\n\n${resultText}\n\nDo not call that tool again for this request. Tell me the outcome and continue from there.`,
          internalMetadata: { kind: 'tool_approval', approvalId: dto.approvalId, tool: outcome.tool, server: outcome.server, decision: 'approved' },
        },
        controller.signal,
      ),
    );
  }

  @Post('tools/deny')
  async denyTool(
    @Body() dto: ToolApprovalDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertChatOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    let outcome: { chatId: string; server: string; tool: string };
    try {
      outcome = await this.mcpTools.deny(user, workspace, dto.approvalId);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? 'Could not record the answer');
    }
    const controller = this.openStream(req, res);
    await this.pipe(
      res,
      this.chats.send(
        user,
        workspace,
        {
          chatId: outcome.chatId,
          content: `I did not approve the "${outcome.tool}" call on ${outcome.server}. Do not call it again; continue without it.`,
          internalMetadata: { kind: 'tool_approval', approvalId: dto.approvalId, tool: outcome.tool, server: outcome.server, decision: 'denied' },
        },
        controller.signal,
      ),
    );
  }

  private openStream(req: FastifyRequest, res: FastifyReply): AbortController {
    res.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    return controller;
  }

  private async pipe(res: FastifyReply, events: AsyncGenerator<ChatStreamEvent>) {
    const raw = res.raw;
    const sendEvent = (payload: unknown) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      for await (const event of events) {
        sendEvent(event);
      }
      if (!raw.writableEnded) raw.write('data: [DONE]\n\n');
    } catch (err: any) {
      sendEvent({ type: 'error', message: err?.message ?? 'The chat failed' });
    } finally {
      if (!raw.writableEnded) raw.end();
    }
  }

  private async assertChatOn(workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    if (ai.chat !== true) {
      throw new ForbiddenException('AI chat is turned off for this workspace');
    }
  }
}
