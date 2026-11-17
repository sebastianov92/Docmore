import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
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
  // The OAuth endpoints answer with the bare RFC bodies, not the app's
  // {data, success, status} envelope, so they write the reply themselves.
  @Public()
  @Post('register')
  async register(@Body() dto: RegisterClientDto, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    try {
      const client = await this.oauth.registerClient(workspace.id, dto);
      return res.status(HttpStatus.CREATED).send(client);
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
  @Post('token')
  async token(
    @Body() dto: TokenRequestDto,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const tokens = await this.oauth.token(workspace, dto, readBasicAuth(req));
    return res.status(HttpStatus.OK).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(tokens);
  }

  @Public()
  @Post('revoke')
  async revoke(@Body() dto: RevokeTokenDto, @AuthWorkspace() workspace: Workspace, @Res() res: FastifyReply) {
    await this.oauth.revokeToken(workspace, dto.token);
    return res.status(HttpStatus.OK).send({});
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
  authorizationServer(@Res() res: FastifyReply) {
    return res.send(this.oauth.authorizationServerMetadata());
  }

  @Public()
  @Get('oauth-protected-resource')
  protectedResource(@Res() res: FastifyReply) {
    return res.send(this.oauth.protectedResourceMetadata());
  }

  @Public()
  @Get('oauth-protected-resource/mcp')
  protectedResourceMcp(@Res() res: FastifyReply) {
    return res.send(this.oauth.protectedResourceMetadata());
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
