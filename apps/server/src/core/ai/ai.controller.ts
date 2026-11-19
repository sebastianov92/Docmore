import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../casl/interfaces/workspace-ability.type';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AI_ACTIONS, AiAction, AiProviderId } from './ai.constants';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderService } from './ai-provider.service';
import { AiGenerateService } from './ai-generate.service';
import { AiEmbeddingService } from './embeddings/ai-embedding.service';
import { AiAnswersService } from './embeddings/ai-answers.service';
import { AskDto, GenerateDto, ListModelsDto, UpdateAiSettingsDto } from './dto/ai.dto';
import { AiUsageService } from './ai-usage.service';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly providers: AiProviderService,
    private readonly generate: AiGenerateService,
    private readonly embeddings: AiEmbeddingService,
    private readonly answers: AiAnswersService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly usage: AiUsageService,
  ) {}

  // What the client needs to know: which AI features are on and backed by a model.
  @HttpCode(HttpStatus.OK)
  @Post('config')
  async config(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const limits = await this.usage.status(workspace, user);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    const generation = await this.settings.generationChoice(workspace.id);
    const embedding = await this.settings.embeddingChoice(workspace.id);
    return {
      configured: Boolean(generation),
      generative: ai.generative === true && Boolean(generation) && limits.allowed,
      search: ai.search === true && Boolean(embedding) && this.embeddings.available && limits.allowed,
      chat: ai.chat === true && limits.allowed,
      model: generation,
      embeddingModel: embedding,
      vectorStore: this.embeddings.available,
      availableActions: AI_ACTIONS,
      limits,
    };
  }

  // AI Answers in search. Server-sent events: data: {"sources": [...]} first,
  // then data: {"content": "..."} per chunk, then [DONE].
  @Post('answers')
  async ask(
    @Body() dto: AskDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertSearchOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    if (!dto.query?.trim()) {
      throw new BadRequestException('Ask a question first');
    }
    const raw = res.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    const send = (payload: unknown) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      for await (const event of this.answers.answer(
        workspace.id,
        user.id,
        dto.query,
        { spaceId: dto.spaceId, includeArchived: dto.includeArchived },
        controller.signal,
      )) {
        send(event);
      }
      if (!raw.writableEnded) raw.write('data: [DONE]\n\n');
    } catch (err: any) {
      send({ error: err?.message ?? 'AI search failed' });
    } finally {
      if (!raw.writableEnded) raw.end();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('embeddings/status')
  @RequireSessionAuth()
  async embeddingStatus(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.embeddings.status(workspace.id);
  }

  // Drops the index and builds it again from every page.
  @HttpCode(HttpStatus.OK)
  @Post('embeddings/reindex')
  @RequireSessionAuth()
  async reindex(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    if (!this.embeddings.available) {
      throw new BadRequestException('AI search needs the pgvector extension on the database');
    }
    await this.embeddings.requestReindex(workspace.id);
    return this.embeddings.status(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('settings')
  @RequireSessionAuth()
  async getSettings(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.settings.view(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('settings/update')
  @RequireSessionAuth()
  async updateSettings(
    @Body() dto: UpdateAiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.settings.update(workspace.id, dto);
  }

  // Asks the provider for its models; also proves the credentials work.
  @HttpCode(HttpStatus.OK)
  @Post('providers/models')
  @RequireSessionAuth()
  async listModels(@Body() dto: ListModelsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    const models = await this.providers.listModels(workspace.id, dto.provider as AiProviderId, {
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl,
    });
    return { models };
  }

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generateOnce(
    @Body() dto: GenerateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertGenerativeOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    const content = await this.generate.complete(workspace.id, {
      action: dto.action as AiAction,
      content: dto.content,
      prompt: dto.prompt,
    });
    return { content };
  }

  // Server-sent events: data: {"content": "..."} per chunk, then [DONE].
  @Post('generate/stream')
  async generateStream(
    @Body() dto: GenerateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertGenerativeOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    const raw = res.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    const send = (payload: unknown) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      for await (const chunk of this.generate.stream(
        workspace.id,
        { action: dto.action as AiAction, content: dto.content, prompt: dto.prompt },
        controller.signal,
      )) {
        send({ content: chunk });
      }
      if (!raw.writableEnded) raw.write('data: [DONE]\n\n');
    } catch (err: any) {
      send({ error: err?.message ?? 'AI generation failed' });
    } finally {
      if (!raw.writableEnded) raw.end();
    }
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
  }

  private async assertGenerativeOn(workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    if (ai.generative !== true) {
      throw new ForbiddenException('Ask AI is turned off for this workspace');
    }
  }

  private async assertSearchOn(workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    if (ai.search !== true) {
      throw new ForbiddenException('AI search is turned off for this workspace');
    }
  }
}
