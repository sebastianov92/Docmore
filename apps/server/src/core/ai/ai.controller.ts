import {
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
import { GenerateDto, ListModelsDto, UpdateAiSettingsDto } from './dto/ai.dto';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly providers: AiProviderService,
    private readonly generate: AiGenerateService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  // What the editor needs to know: is Ask AI on and backed by a model.
  @HttpCode(HttpStatus.OK)
  @Post('config')
  async config(@AuthWorkspace() workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    const generation = await this.settings.generationChoice(workspace.id);
    return {
      configured: Boolean(generation),
      generative: ai.generative === true && Boolean(generation),
      search: ai.search === true,
      chat: ai.chat === true,
      model: generation,
      availableActions: AI_ACTIONS,
    };
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
  async generateOnce(@Body() dto: GenerateDto, @AuthWorkspace() workspace: Workspace) {
    await this.assertGenerativeOn(workspace);
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
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    await this.assertGenerativeOn(workspace);
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
}
