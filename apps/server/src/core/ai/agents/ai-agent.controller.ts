import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiAgentService } from './ai-agent.service';

class AgentFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6000)
  instructions?: string;

  // null: every space the person can see
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  spaceId?: string | null;

  // checked by hand in the service
  @IsOptional()
  @IsObject()
  schedule?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  output?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  allowEdits?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class AgentIdDto {
  @IsUUID()
  agentId: string;
}

class UpdateAgentDto extends AgentFieldsDto {
  @IsUUID()
  agentId: string;
}

class AgentRunsDto extends AgentIdDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class RunIdDto {
  @IsUUID()
  runId: string;
}

// Scheduled agents of the signed-in person (an admin also sees the others').
@UseGuards(JwtAuthGuard)
@Controller('ai/agents')
export class AiAgentController {
  constructor(private readonly agents: AiAgentService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.agents.list(user, workspace) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  info(@Body() dto: AgentIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.agents.info(user, workspace, dto.agentId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(@Body() dto: AgentFieldsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.agents.create(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(@Body() dto: UpdateAgentDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const { agentId, ...fields } = dto;
    return this.agents.update(user, workspace, agentId, fields);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  remove(@Body() dto: AgentIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.agents.remove(user, workspace, dto.agentId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('run')
  run(@Body() dto: AgentIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.agents.runNow(user, workspace, dto.agentId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('runs')
  async runs(@Body() dto: AgentRunsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return { items: await this.agents.runs(user, workspace, dto.agentId, dto.limit) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('runs/info')
  runInfo(@Body() dto: RunIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.agents.run(user, workspace, dto.runId);
  }
}
