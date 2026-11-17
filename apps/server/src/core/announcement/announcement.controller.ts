import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../casl/interfaces/workspace-ability.type';
import { AnnouncementService } from './announcement.service';
import {
  AnnouncementIdDto,
  CreateAnnouncementDto,
  ListAnnouncementsDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

@Controller('announcements')
export class AnnouncementController {
  constructor(
    private readonly announcements: AnnouncementService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@Body() dto: ListAnnouncementsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.announcements.list(workspace.id, dto);
  }

  // Banners for signed-in members.
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('visible')
  async visible(@AuthWorkspace() workspace: Workspace) {
    return this.announcements.visible(workspace.id, 'app');
  }

  // Banners for everyone: login page, shared and public pages.
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('public')
  async publicBanners(@AuthWorkspace() workspace: Workspace) {
    return this.announcements.visible(workspace.id, 'public');
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateAnnouncementDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.announcements.create(workspace.id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() dto: UpdateAnnouncementDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.announcements.update(workspace.id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('archive')
  async archive(@Body() dto: AnnouncementIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.announcements.archive(workspace.id, user, dto.announcementId);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('unarchive')
  async unarchive(@Body() dto: AnnouncementIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.announcements.unarchive(workspace.id, user, dto.announcementId);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async remove(@Body() dto: AnnouncementIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    await this.announcements.delete(workspace.id, dto.announcementId);
    return {};
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
  }
}
