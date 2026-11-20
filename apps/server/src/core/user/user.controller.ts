import {
  ForbiddenException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserIdDto } from './dto/user-id.dto';
import { UserRole } from '../../common/helpers/types/permission';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('me')
  @OAuthScope('read')
  async getUserInfo(
    @AuthUser() authUser: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const memberCount = await this.workspaceRepo.getActiveUserCount(
      workspace.id,
    );

    const { licenseKey, ...rest } = workspace;

    const workspaceInfo = {
      ...rest,
      memberCount,
    };

    return { user: authUser, workspace: workspaceInfo };
  }

  // Public profile of a workspace member (people directory).
  @HttpCode(HttpStatus.OK)
  @Post('info')
  @OAuthScope('read')
  async getMemberInfo(
    @Body() dto: UserIdDto,
    @AuthUser() authUser: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (authUser.role === UserRole.GUEST) throw new ForbiddenException();
    const member = await this.userRepo.findById(dto.userId, workspace.id);
    if (!member || member.deletedAt) {
      throw new NotFoundException('User not found');
    }
    return {
      id: member.id,
      name: member.name,
      email: member.email,
      avatarUrl: member.avatarUrl,
      role: member.role,
      timezone: member.timezone,
      locale: member.locale,
      createdAt: member.createdAt,
      lastActiveAt: member.lastActiveAt,
      deactivatedAt: member.deactivatedAt,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateUser(
    @Body() updateUserDto: UpdateUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.userService.update(updateUserDto, user.id, workspace);
  }
}
