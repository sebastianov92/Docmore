import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ScimTokenService } from './scim-token.service';

export class CreateScimTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}
export class ScimTokenIdDto {
  @IsUUID()
  id: string;
}

// Owner-only: the tokens an identity provider uses, shown once.
@UseGuards(JwtAuthGuard)
@Controller('scim/tokens')
export class ScimTokenController {
  constructor(
    private readonly tokens: ScimTokenService,
    private readonly environment: EnvironmentService,
  ) {}

  private assertOwner(user: User) {
    if (user.role !== UserRole.OWNER) throw new ForbiddenException('Only the workspace owner manages SCIM');
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    return {
      items: await this.tokens.list(workspace.id),
      baseUrl: `${this.environment.getAppUrl().replace(/\/+$/, '')}/api/scim/v2`,
      enabled: Boolean((workspace as any).isScimEnabled),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateScimTokenDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    if (!(workspace as any).isScimEnabled) throw new ForbiddenException('Turn SCIM on in the workspace settings first');
    return this.tokens.create(workspace.id, user.id, dto.name ?? 'SCIM');
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(@Body() dto: ScimTokenIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user);
    await this.tokens.revoke(workspace.id, dto.id);
  }
}
