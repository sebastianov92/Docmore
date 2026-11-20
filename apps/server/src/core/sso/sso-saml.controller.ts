import { Body, Controller, Get, Header, HttpException, Logger, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ALL_NAMED_THROTTLERS_SKIPPED, AUTH_THROTTLER } from '../../integrations/throttle/throttler-names';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SamlService } from './saml.service';
import { buildLoginErrorUrl, safeRedirectPath, SSO_STATE_COOKIE, SSO_STATE_COOKIE_PATH, SSO_STATE_TTL_SECONDS } from './sso.utils';

// The browser-facing half of SAML: out to the IdP, back at the assertion
// consumer service, plus the SP metadata admins paste into the IdP.
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('sso/saml')
export class SsoSamlController {
  private readonly logger = new Logger(SsoSamlController.name);

  constructor(
    private readonly saml: SamlService,
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
      const provider = await this.saml.getEnabledProvider(providerId, workspace.id);
      const { authorizationUrl, stateToken } = await this.saml.startLogin(provider, workspace, safeRedirectPath(redirect));
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

  // The IdP posts the SAMLResponse here (form-urlencoded).
  @Post(':providerId/callback')
  async callback(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() body: Record<string, string>,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const cookieState = (req.cookies as Record<string, string>)?.[SSO_STATE_COOKIE];
    res.clearCookie(SSO_STATE_COOKIE, { path: SSO_STATE_COOKIE_PATH });
    try {
      const provider = await this.saml.getEnabledProvider(providerId, workspace.id);
      const { authToken, redirect } = await this.saml.completeLogin(provider, workspace, body ?? {}, cookieState);
      res.setCookie('authToken', authToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        expires: this.environmentService.getCookieExpiresIn(),
        secure: this.environmentService.isHttps(),
      });
      return res.redirect(new URL(redirect ?? '/home', this.environmentService.getAppUrl()).href, 302);
    } catch (err) {
      return this.failLogin(res, err);
    }
  }

  @Get(':providerId/metadata')
  @Header('content-type', 'application/xml')
  async metadata(@Param('providerId', new ParseUUIDPipe()) providerId: string, @AuthWorkspace() workspace: Workspace) {
    const provider = await this.saml.getEnabledProvider(providerId, workspace.id);
    return this.saml.metadata(provider);
  }

  private failLogin(res: FastifyReply, err: unknown) {
    const message = err instanceof HttpException ? err.message : 'Single sign-on failed. Please try again.';
    if (!(err instanceof HttpException)) this.logger.error(`SAML login failed: ${(err as Error)?.message}`);
    return res.redirect(buildLoginErrorUrl(this.environmentService.getAppUrl(), message), 302);
  }
}
