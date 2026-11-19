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
import { WorkspaceService } from '../services/workspace.service';
import { UpdateWorkspaceDto } from '../dto/update-workspace.dto';
import { UpdateWorkspaceUserRoleDto } from '../dto/update-workspace-user-role.dto';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { WorkspaceInvitationService } from '../services/workspace-invitation.service';
import { Public } from '../../../common/decorators/public.decorator';
import {
  AcceptInviteDto,
  InvitationIdDto,
  InviteUserDto,
  RevokeInviteDto,
} from '../dto/invitation.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../casl/interfaces/workspace-ability.type';
import { FastifyReply } from 'fastify';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { LicenseCheckService } from '../../../integrations/environment/license-check.service';
import { CheckHostnameDto } from '../dto/check-hostname.dto';
import { RemoveWorkspaceUserDto } from '../dto/remove-workspace-user.dto';
import { ListWorkspaceUsersDto } from '../dto/list-workspace-users.dto';
import { resolveWorkspaceUserListStatus } from '../workspace.util';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { WorkspaceInviteRequestService } from '../services/workspace-invite-request.service';
import { CreateInviteRequestDto, InviteRequestIdDto } from '../dto/invite-request.dto';
import { WorkspaceDomainService } from '../services/workspace-domain.service';
import { DomainAutoJoinDto, DomainDto } from '../dto/domain.dto';

@UseGuards(JwtAuthGuard)
@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceInvitationService: WorkspaceInvitationService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
    private licenseCheckService: LicenseCheckService,
    private readonly inviteRequestService: WorkspaceInviteRequestService,
    private readonly domainService: WorkspaceDomainService,
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/public')
  async getWorkspacePublicInfo(@Req() req: any) {
    return this.workspaceService.getWorkspacePublicData(req.raw.workspaceId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/info')
  @OAuthScope('read')
  async getWorkspace(@AuthWorkspace() workspace: Workspace) {
    return this.workspaceService.getWorkspaceInfo(workspace.id);
  }

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('entitlements')
  async getEntitlements(@AuthWorkspace() workspace: Workspace) {
    let { licenseKey } = workspace;
    const { plan } = workspace;

    if (!licenseKey) {
      licenseKey = await this.workspaceRepo.findLicenseKeyById(workspace.id);
    }

    return {
      cloud: this.environmentService.isCloud(),
      tier: this.licenseCheckService.resolveTier(licenseKey, plan),
      features: this.licenseCheckService.resolveFeatures(licenseKey, plan),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateWorkspace(
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() dto: UpdateWorkspaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    const updatedWorkspace = await this.workspaceService.update(
      workspace.id,
      dto,
    );

    if (
      dto.hostname &&
      dto.hostname === updatedWorkspace.hostname &&
      workspace.hostname !== updatedWorkspace.hostname
    ) {
      // log user out of old hostname
      res.clearCookie('authToken');
    }

    return updatedWorkspace;
  }

  @HttpCode(HttpStatus.OK)
  @Post('members')
  @OAuthScope('read')
  async getWorkspaceMembers(
    @Body()
    dto: ListWorkspaceUsersDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.workspaceService.getWorkspaceUsers(workspace.id, dto, {
      status: resolveWorkspaceUserListStatus(
        dto.status,
        ability.can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member),
      ),
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/deactivate')
  async deactivateWorkspaceMember(
    @Body() dto: RemoveWorkspaceUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }
    await this.workspaceService.deactivateUser(user, dto.userId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/activate')
  async activateWorkspaceMember(
    @Body() dto: RemoveWorkspaceUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }
    await this.workspaceService.activateUser(user, dto.userId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/delete')
  async deleteWorkspaceMember(
    @Body() dto: RemoveWorkspaceUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }
    await this.workspaceService.deleteUser(user, dto.userId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/change-role')
  async updateWorkspaceMemberRole(
    @Body() workspaceUserRoleDto: UpdateWorkspaceUserRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }

    return this.workspaceService.updateWorkspaceUserRole(
      user,
      workspaceUserRoleDto,
      workspace.id,
    );
  }

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('invites')
  async getInvitations(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body()
    pagination: PaginationOptions,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.workspaceInvitationService.getInvitations(
      workspace.id,
      pagination,
    );
  }

  // Verified domains (DNS TXT) and self sign-up for their emails.
  @HttpCode(HttpStatus.OK)
  @Post('domains')
  async listDomains(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertManageSettings(user, workspace);
    return this.domainService.list(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('domains/add')
  async addDomain(
    @Body() dto: DomainDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertManageSettings(user, workspace);
    return this.domainService.add(workspace.id, dto.domain);
  }

  @HttpCode(HttpStatus.OK)
  @Post('domains/verify')
  async verifyDomain(
    @Body() dto: DomainDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertManageSettings(user, workspace);
    return this.domainService.verify(workspace.id, dto.domain);
  }

  @HttpCode(HttpStatus.OK)
  @Post('domains/remove')
  async removeDomain(
    @Body() dto: DomainDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertManageSettings(user, workspace);
    return this.domainService.remove(workspace.id, dto.domain);
  }

  @HttpCode(HttpStatus.OK)
  @Post('domains/auto-join')
  async setDomainAutoJoin(
    @Body() dto: DomainAutoJoinDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertManageSettings(user, workspace);
    return this.domainService.setAutoJoin(workspace.id, dto.autoJoin);
  }

  private assertManageSettings(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
  }

  // Invite requests: any member asks, admins approve (which sends the invite).
  @HttpCode(HttpStatus.OK)
  @Post('invite-requests/create')
  async createInviteRequest(
    @Body() dto: CreateInviteRequestDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.inviteRequestService.create(user, workspace, dto.emails, dto.note);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invite-requests/mine')
  async myInviteRequests(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.inviteRequestService.listMine(user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invite-requests')
  async listInviteRequests(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }
    return this.inviteRequestService.listPending(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invite-requests/approve')
  async approveInviteRequest(
    @Body() dto: InviteRequestIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }
    return this.inviteRequestService.review(user, workspace, dto.requestId, true);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invite-requests/reject')
  async rejectInviteRequest(
    @Body() dto: InviteRequestIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }
    return this.inviteRequestService.review(user, workspace, dto.requestId, false);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('invites/info')
  async getInvitationById(
    @Body() dto: InvitationIdDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.workspaceInvitationService.getInvitationById(
      dto.invitationId,
      workspace,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('invites/create')
  async inviteUser(
    @Body() inviteUserDto: InviteUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }

    return this.workspaceInvitationService.createInvitation(
      inviteUserDto,
      workspace,
      user,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('invites/resend')
  async resendInvite(
    @Body() revokeInviteDto: RevokeInviteDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }

    return this.workspaceInvitationService.resendInvitation(
      revokeInviteDto.invitationId,
      workspace,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('invites/revoke')
  async revokeInvite(
    @Body() revokeInviteDto: RevokeInviteDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }

    return this.workspaceInvitationService.revokeInvitation(
      revokeInviteDto.invitationId,
      workspace.id,
    );
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('invites/accept')
  async acceptInvite(
    @Body() acceptInviteDto: AcceptInviteDto,
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.workspaceInvitationService.acceptInvitation(
      acceptInviteDto,
      workspace,
    );

    if (result.requiresLogin) {
      return {
        requiresLogin: true,
      };
    }

    res.setCookie('authToken', result.authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });

    return {
      requiresLogin: false,
    };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/check-hostname')
  async checkHostname(@Body() checkHostnameDto: CheckHostnameDto) {
    return this.workspaceService.checkHostname(checkHostnameDto.hostname);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invites/link')
  async getInviteLink(
    @Body() inviteDto: InvitationIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (this.environmentService.isCloud()) {
      throw new ForbiddenException();
    }

    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)
    ) {
      throw new ForbiddenException();
    }
    const inviteLink =
      await this.workspaceInvitationService.getInvitationLinkById(
        inviteDto.invitationId,
        workspace,
      );

    return { inviteLink };
  }
}
