import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../../common/decorators/require-session-auth.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiSkillService } from './ai-skill.service';
import { CreateSkillDto, ListSkillsDto, SkillIdDto, UpdateSkillDto } from './ai-skill.dto';

@UseGuards(JwtAuthGuard)
@Controller('ai/skills')
export class AiSkillController {
  constructor(private readonly skills: AiSkillService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@Body() dto: ListSkillsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.skills.list(user, workspace, { enabledOnly: dto.enabledOnly }) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  @RequireSessionAuth()
  async create(@Body() dto: CreateSkillDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.skills.create(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  @RequireSessionAuth()
  async update(@Body() dto: UpdateSkillDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.skills.update(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  @RequireSessionAuth()
  async remove(@Body() dto: SkillIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.skills.remove(user, workspace, dto.skillId);
    return {};
  }
}
