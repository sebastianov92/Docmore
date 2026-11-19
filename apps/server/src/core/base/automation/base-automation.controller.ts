import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BaseAutomationService } from './base-automation.service';
import {
  AutomationIdDto,
  CreateAutomationDto,
  ListAutomationsDto,
  ListRunsDto,
  RunAutomationDto,
  UpdateAutomationDto,
} from '../dto/automation.dto';

@UseGuards(JwtAuthGuard)
@Controller('bases/automations')
export class BaseAutomationController {
  constructor(
    private readonly automations: BaseAutomationService,
    private readonly baseRepo: BaseRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  private async base(pageId: string, user: User, mode: 'view' | 'edit') {
    const base = await this.baseRepo.findById(pageId);
    if (!base) throw new NotFoundException('Base not found');
    if (mode === 'edit') await this.pageAccessService.validateCanEdit(base, user);
    else await this.pageAccessService.validateCanView(base, user);
    return base;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post()
  async list(@Body() dto: ListAutomationsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'view');
    return { items: await this.automations.list(dto.pageId, workspace.id) };
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('create')
  async create(@Body() dto: CreateAutomationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    return this.automations.create(dto, workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('update')
  async update(@Body() dto: UpdateAutomationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    return this.automations.update(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('delete')
  async delete(@Body() dto: AutomationIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    await this.automations.delete(dto.automationId, dto.pageId, workspace.id);
  }

  // Buttons and "Run now".
  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('run')
  async run(@Body() dto: RunAutomationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    return this.automations.runManually(dto.automationId, dto.pageId, workspace.id, user.id, dto.rowId);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post('runs')
  async runs(@Body() dto: ListRunsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'view');
    return { items: await this.automations.listRuns(dto.automationId, dto.pageId, workspace.id, dto.limit) };
  }
}
