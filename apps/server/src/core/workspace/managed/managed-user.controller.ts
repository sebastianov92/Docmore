import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { ManagedUserService } from './managed-user.service';

class MemberIdDto {
  @IsUUID()
  userId: string;
}
class MemberProfileDto extends MemberIdDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
class MemberPasswordDto extends MemberIdDto {
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password: string;
}
class MemberPasswordLoginDto extends MemberIdDto {
  @IsBoolean()
  locked: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('workspace/members')
export class ManagedUserController {
  constructor(private readonly managed: ManagedUserService) {}

  @HttpCode(HttpStatus.OK)
  @Post('profile')
  @RequireSessionAuth()
  async profile(@Body() dto: MemberProfileDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.managed.updateProfile(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('sign-out')
  @RequireSessionAuth()
  async signOut(@Body() dto: MemberIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.managed.signOut(user, workspace, dto.userId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @RequireSessionAuth()
  async resetPassword(@Body() dto: MemberIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.managed.resetPassword(user, workspace, dto.userId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('set-password')
  @RequireSessionAuth()
  async setPassword(@Body() dto: MemberPasswordDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.managed.setPassword(user, workspace, dto.userId, dto.password);
  }

  @HttpCode(HttpStatus.OK)
  @Post('password-login')
  @RequireSessionAuth()
  async passwordLogin(@Body() dto: MemberPasswordLoginDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.managed.setPasswordLogin(user, workspace, dto.userId, dto.locked);
  }
}
