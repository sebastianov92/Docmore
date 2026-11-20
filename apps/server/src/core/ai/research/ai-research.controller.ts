import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AiUsageService } from '../ai-usage.service';
import { AiResearchService } from './ai-research.service';

class StartResearchDto {
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  question: string;

  @IsOptional()
  @IsUUID()
  chatId?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

class ReportIdDto {
  @IsUUID()
  reportId: string;
}

class SaveReportDto extends ReportIdDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('ai/research')
export class AiResearchController {
  constructor(
    private readonly research: AiResearchService,
    private readonly usage: AiUsageService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('start')
  async start(@Body() dto: StartResearchDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.assertChatOn(workspace);
    await this.usage.assertAllowed(workspace, user);
    return this.research.start(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('status')
  async status(@Body() dto: ReportIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.research.status(user, workspace, dto.reportId);
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.research.list(user, workspace) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('save-page')
  async save(@Body() dto: SaveReportDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.research.saveAsPage(user, workspace, dto);
  }

  private async assertChatOn(workspace: Workspace) {
    const ws = await this.workspaceRepo.findById(workspace.id);
    const ai = ((ws?.settings as any)?.ai ?? {}) as Record<string, any>;
    if (ai.chat !== true) throw new ForbiddenException('AI chat is turned off for this workspace');
  }
}
