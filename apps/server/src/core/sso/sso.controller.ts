import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { SsoService } from './sso.service';
import {
  CreateSsoProviderDto,
  ProviderIdDto,
  UpdateSsoProviderDto,
} from './dto/sso.dto';

// Provider management is admin-only and browser-session-only: an API key
// must not be able to add a sign-in method.
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('sso')
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  @HttpCode(HttpStatus.OK)
  @Post('providers')
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.ssoService.list(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ProviderIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.info(user, workspace, dto.providerId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateSsoProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.create(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateSsoProviderDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.ssoService.update(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: ProviderIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.ssoService.delete(user, workspace, dto.providerId);
  }
}
