import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  JwtApiKeyPayload,
  JwtAttachmentPayload,
  JwtCollabPayload,
  JwtExchangePayload,
  JwtMfaTokenPayload,
  JwtOAuthPayload,
  JwtPayload,
  JwtPdfExportDownloadPayload,
  JwtPdfRenderPayload,
  JwtSsoStatePayload,
  JwtType,
} from '../dto/jwt-payload';
import { User } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers';

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private environmentService: EnvironmentService,
  ) {}

  async generateAccessToken(user: User, sessionId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      workspaceId: user.workspaceId,
      type: JwtType.ACCESS,
      sessionId,
    };
    return this.jwtService.sign(payload);
  }

  async generateCollabToken(user: User, workspaceId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtCollabPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.COLLAB,
    };
    const expiresIn = '24h';
    return this.jwtService.sign(payload, { expiresIn });
  }

  async generateExchangeToken(
    userId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtExchangePayload = {
      sub: userId,
      workspaceId: workspaceId,
      type: JwtType.EXCHANGE,
    };
    return this.jwtService.sign(payload, { expiresIn: '10s' });
  }

  async generateAttachmentToken(opts: {
    attachmentId: string;
    pageId: string;
    workspaceId: string;
  }): Promise<string> {
    const { attachmentId, pageId, workspaceId } = opts;
    const payload: JwtAttachmentPayload = {
      attachmentId: attachmentId,
      pageId: pageId,
      workspaceId: workspaceId,
      type: JwtType.ATTACHMENT,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  async generateMfaToken(user: User, workspaceId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtMfaTokenPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.MFA_TOKEN,
    };
    return this.jwtService.sign(payload, { expiresIn: '5m' });
  }

  // Docmore SSO: binds the browser that started a login to the callback (state, nonce, PKCE).
  async generateSsoStateToken(
    payload: Omit<JwtSsoStatePayload, 'type'>,
  ): Promise<string> {
    const fullPayload: JwtSsoStatePayload = { ...payload, type: 'sso_state' };
    return this.jwtService.sign(fullPayload, { expiresIn: '10m' });
  }

  async generateApiToken(opts: {
    apiKeyId: string;
    user: User;
    workspaceId: string;
    expiresIn: StringValue | number;
  }): Promise<string> {
    const { apiKeyId, user, workspaceId, expiresIn } = opts;
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtApiKeyPayload = {
      sub: user.id,
      apiKeyId: apiKeyId,
      workspaceId,
      type: JwtType.API_KEY,
    };

    return this.jwtService.sign(payload, { expiresIn });
  }

  // OAuth access token for MCP clients: issuer and audience come from the
  // sign options so they override the module's default issuer.
  async generateOAuthAccessToken(
    payload: Omit<JwtOAuthPayload, 'iss' | 'aud'>,
    opts: { issuer: string; audience: string; expiresInSeconds: number },
  ): Promise<string> {
    return this.jwtService.sign(payload, {
      expiresIn: opts.expiresInSeconds,
      issuer: opts.issuer,
      audience: opts.audience,
    });
  }

  // Verifies a token that may be one of several kinds (bearer on /mcp).
  async verifyJwtOfTypes(token: string, types: string[]) {
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.environmentService.getAppSecret(),
    });
    if (!types.includes(payload?.type)) {
      throw new UnauthorizedException('Invalid JWT token. Token type does not match.');
    }
    return payload;
  }

  async generatePdfRenderToken(
    pageId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfRenderPayload = {
      pageId,
      workspaceId,
      type: JwtType.PDF_RENDER,
    };
    return this.jwtService.sign(payload, { expiresIn: '60s' });
  }

  async generatePdfExportDownloadToken(
    fileTaskId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfExportDownloadPayload = {
      fileTaskId,
      workspaceId,
      type: JwtType.PDF_EXPORT_DOWNLOAD,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  async verifyJwt(token: string, tokenType: string) {
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.environmentService.getAppSecret(),
    });

    if (payload.type !== tokenType) {
      throw new UnauthorizedException(
        'Invalid JWT token. Token type does not match.',
      );
    }

    return payload;
  }
}
