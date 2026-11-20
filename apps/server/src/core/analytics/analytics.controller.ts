import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../casl/interfaces/workspace-ability.type';
import { SpaceCaslAction, SpaceCaslSubject } from '../casl/interfaces/space-ability.type';
import { AnalyticsService } from './analytics.service';
import { PageStatsDto, TrackViewDto, WorkspaceStatsDto } from './analytics.dto';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  // Called once when a page opens.
  @HttpCode(HttpStatus.OK)
  @Post('track')
  async track(@Body() dto: TrackViewDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.workspaceId !== workspace.id || page.deletedAt) throw new NotFoundException('Page not found');
    await this.pageAccessService.validateCanView(page, user);
    await this.analytics.track(page, user.id, workspace);
    return { ok: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('page')
  async page(@Body() dto: PageStatsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.workspaceId !== workspace.id) throw new NotFoundException('Page not found');
    await this.pageAccessService.validateCanView(page, user);
    return { ...(await this.analytics.pageStats(page.id, dto.days ?? 30)), settings: this.analytics.settings(workspace) };
  }

  // Workspace admins, or space admins for their space.
  @HttpCode(HttpStatus.OK)
  @Post('workspace')
  async workspaceStats(@Body() dto: WorkspaceStatsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      if (!dto.spaceId) throw new ForbiddenException();
      const spaceAbility = await this.spaceAbility.createForUser(user, dto.spaceId);
      if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) throw new ForbiddenException();
    }
    return { ...(await this.analytics.workspaceStats(workspace.id, dto.days ?? 30, dto.spaceId)), settings: this.analytics.settings(workspace) };
  }
}
