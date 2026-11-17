import {
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OidcService } from './oidc.service';
import {
  buildLoginErrorUrl,
  safeRedirectPath,
  SSO_STATE_COOKIE,
  SSO_STATE_COOKIE_PATH,
  SSO_STATE_TTL_SECONDS,
} from './sso.utils';

// The browser-facing half of OpenID Connect: redirect out to the identity
// provider, then turn its callback into a Docmore session. Both routes are
// public and rate-limited like the password login.
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('sso/oidc')
export class SsoOidcController {
  private readonly logger = new Logger(SsoOidcController.name);

  constructor(
    private readonly oidcService: OidcService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Get(':providerId/login')
  async login(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Query('redirect') redirect: string | undefined,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    try {
      const provider = await this.oidcService.getEnabledProvider(
        providerId,
        workspace.id,
      );
      const { authorizationUrl, stateToken } =
        await this.oidcService.startLogin(
          provider,
          workspace,
          safeRedirectPath(redirect),
        );

      res.setCookie(SSO_STATE_COOKIE, stateToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: SSO_STATE_COOKIE_PATH,
        maxAge: SSO_STATE_TTL_SECONDS,
        secure: this.environmentService.isHttps(),
      });
      return res.redirect(authorizationUrl, 302);
    } catch (err) {
      return this.failLogin(res, err);
    }
  }

  @Get(':providerId/callback')
  async callback(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    res.clearCookie(SSO_STATE_COOKIE, { path: SSO_STATE_COOKIE_PATH });
    try {
      const provider = await this.oidcService.getEnabledProvider(
        providerId,
        workspace.id,
      );
      const stateToken = (req.cookies as Record<string, string>)?.[
        SSO_STATE_COOKIE
      ];
      const callbackUrl = new URL(
        req.raw.url ?? '',
        this.environmentService.getAppUrl(),
      );

      const { authToken, redirect } = await this.oidcService.completeLogin(
        provider,
        workspace,
        callbackUrl,
        stateToken,
      );

      res.setCookie('authToken', authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });
      return res.redirect(
        new URL(redirect ?? '/home', this.environmentService.getAppUrl()).href,
        302,
      );
    } catch (err) {
      return this.failLogin(res, err);
    }
  }

  // Whatever went wrong, the user lands back on the login page with a reason
  // they can act on; details stay in the server log.
  private failLogin(res: FastifyReply, err: unknown) {
    const message =
      err instanceof HttpException
        ? extractMessage(err)
        : 'Single sign-on failed. Please try again or contact an administrator.';
    if (!(err instanceof HttpException)) {
      this.logger.error(
        `OIDC login failed: ${err instanceof Error ? err.stack : String(err)}`,
      );
    }
    return res.redirect(
      buildLoginErrorUrl(this.environmentService.getAppUrl(), message),
      302,
    );
  }
}

function extractMessage(err: HttpException): string {
  const response = err.getResponse();
  if (typeof response === 'string') return response;
  const body = response as { message?: string | string[] };
  if (Array.isArray(body.message)) return body.message.join(', ');
  return body.message ?? err.message;
}
