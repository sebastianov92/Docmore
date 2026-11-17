import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { OAuthRegistrationError, OAuthService } from './oauth.service';
import {
  ApproveAuthorizationDto,
  AuthorizeParamsDto,
  GrantIdDto,
  RegisterClientDto,
  RevokeTokenDto,
  TokenRequestDto,
} from './dto/oauth.dto';

// /api/oauth/*: the authorization server's endpoints. The consent screen
// itself is the client route /oauth/consent, which calls authorize-info
// and authorize with the user's session.
@Controller('oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  // RFC 7591: MCP clients register themselves before the first login.
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  async register(@Body() dto: RegisterClientDto, @AuthWorkspace() workspace: Workspace) {
    try {
      return await this.oauth.registerClient(workspace.id, dto);
    } catch (err) {
      if (err instanceof OAuthRegistrationError) {
        throw new BadRequestException({ error: err.code, error_description: err.message, message: err.message });
      }
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('authorize-info')
  async authorizeInfo(@Body() dto: AuthorizeParamsDto, @AuthWorkspace() workspace: Workspace) {
    return this.oauth.authorizeInfo(workspace, dto);
  }

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('authorize')
  async authorize(@Body() dto: ApproveAuthorizationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.oauth.approve(user, workspace, dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Post('token')
  async token(@Body() dto: TokenRequestDto, @AuthWorkspace() workspace: Workspace, @Req() req: FastifyRequest) {
    return this.oauth.token(workspace, dto, readBasicAuth(req));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(@Body() dto: RevokeTokenDto, @AuthWorkspace() workspace: Workspace) {
    await this.oauth.revokeToken(workspace, dto.token);
    return {};
  }

  // Apps connected to the signed-in user's account.
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('grants')
  async grants(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.oauth.listGrants(user, workspace);
  }

  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  @HttpCode(HttpStatus.OK)
  @Post('grants/revoke')
  async revokeGrant(@Body() dto: GrantIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.oauth.revokeGrant(user, workspace, dto.grantId);
    return {};
  }
}

// Served at the site root (excluded from the /api prefix in main.ts).
@Controller('.well-known')
export class OAuthMetadataController {
  constructor(private readonly oauth: OAuthService) {}

  @Public()
  @Get('oauth-authorization-server')
  authorizationServer() {
    return this.oauth.authorizationServerMetadata();
  }

  @Public()
  @Get('oauth-protected-resource')
  protectedResource() {
    return this.oauth.protectedResourceMetadata();
  }

  @Public()
  @Get('oauth-protected-resource/mcp')
  protectedResourceMcp() {
    return this.oauth.protectedResourceMetadata();
  }
}

function readBasicAuth(req: FastifyRequest): { clientId: string; secret: string } | null {
  const header = req.headers.authorization;
  if (!header || !/^basic /i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return null;
    return { clientId: decodeURIComponent(decoded.slice(0, index)), secret: decodeURIComponent(decoded.slice(index + 1)) };
  } catch {
    return null;
  }
}
