import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SAML } from '@node-saml/node-saml';
import { randomBytes } from 'crypto';
import { AuthProvider, Workspace } from '@docmost/db/types/entity.types';
import { AuthProviderRepo } from '@docmost/db/repos/auth-provider/auth-provider.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from '../auth/services/token.service';
import { JwtType, JwtSsoStatePayload } from '../auth/dto/jwt-payload';
import { AuthService } from '../auth/services/auth.service';
import { OidcService } from './oidc.service';
import { SsoIdentity } from './sso.utils';

// SAML 2.0 service provider: redirect to the IdP, take the signed response
// at the ACS, hand the identity to the same user resolution OIDC uses.
@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  constructor(
    private readonly authProviderRepo: AuthProviderRepo,
    private readonly environmentService: EnvironmentService,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
    private readonly oidc: OidcService,
  ) {}

  async getEnabledProvider(providerId: string, workspaceId: string): Promise<AuthProvider> {
    const provider = await this.authProviderRepo.findById(providerId, workspaceId);
    if (!provider || provider.type !== 'saml' || !provider.isEnabled || !provider.samlUrl || !provider.samlCertificate) {
      throw new NotFoundException('This sign-in method is not available');
    }
    return provider;
  }

  callbackUrl(providerId: string): string {
    return `${this.appUrl()}/api/sso/saml/${providerId}/callback`;
  }

  entityId(providerId: string): string {
    return `${this.appUrl()}/api/sso/saml/${providerId}/metadata`;
  }

  async startLogin(provider: AuthProvider, workspace: Workspace, redirect: string | null) {
    const state = randomBytes(16).toString('hex');
    const stateToken = await this.tokenService.generateSsoStateToken({
      providerId: provider.id,
      workspaceId: workspace.id,
      state,
      nonce: '',
      codeVerifier: '',
      redirect,
    });
    const url = await this.saml(provider).getAuthorizeUrlAsync(stateToken, undefined, {});
    return { authorizationUrl: url, stateToken };
  }

  async completeLogin(provider: AuthProvider, workspace: Workspace, body: Record<string, string>, cookieState: string | undefined) {
    const stateToken = body?.RelayState || cookieState;
    if (!stateToken) throw new BadRequestException('Your sign-in session expired. Please start again.');
    let claims: JwtSsoStatePayload;
    try {
      claims = await this.tokenService.verifyJwt(stateToken, JwtType.SSO_STATE);
    } catch {
      throw new BadRequestException('Your sign-in session expired. Please start again.');
    }
    if (claims.providerId !== provider.id || claims.workspaceId !== workspace.id) {
      throw new BadRequestException('Sign-in request does not match');
    }
    let profile: Record<string, any> | null;
    try {
      const result = await this.saml(provider).validatePostResponseAsync(body);
      profile = (result.profile ?? null) as Record<string, any> | null;
    } catch (err: any) {
      this.logger.warn(`SAML response rejected for provider ${provider.id}: ${err?.message}`);
      throw new UnauthorizedException('The identity provider rejected the sign-in. Please try again.');
    }
    const identity = identityFromProfile(profile);
    if (!identity) throw new UnauthorizedException('The identity provider did not share an email address for your account');
    const user = await this.oidc.resolveUser(provider, workspace, identity);
    if (provider.groupSync) await this.oidc.syncGroups(user, workspace, identity.groups);
    const authToken = await this.authService.completeLogin(user, workspace.id, 'saml');
    return { authToken, redirect: claims.redirect };
  }

  metadata(provider: AuthProvider): string {
    return this.saml(provider).generateServiceProviderMetadata(null, null);
  }

  private saml(provider: AuthProvider): SAML {
    return new SAML({
      callbackUrl: this.callbackUrl(provider.id),
      entryPoint: provider.samlUrl!,
      issuer: this.entityId(provider.id),
      idpCert: normalizeCert(provider.samlCertificate!),
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      identifierFormat: null,
      acceptedClockSkewMs: 60_000,
      disableRequestedAuthnContext: true,
    });
  }

  private appUrl(): string {
    return this.environmentService.getAppUrl().replace(/\/+$/, '');
  }
}

// PEM with or without headers and whitespace, as IdPs paste it.
function normalizeCert(cert: string): string {
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

const EMAIL_CLAIMS = [
  'email',
  'mail',
  'emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];
const NAME_CLAIMS = [
  'displayName',
  'name',
  'cn',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'http://schemas.microsoft.com/identity/claims/displayname',
];
const GROUP_CLAIMS = ['groups', 'memberOf', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'http://schemas.xmlsoap.org/claims/Group'];

function first(profile: Record<string, any>, keys: string[]): string | null {
  for (const k of keys) {
    const v = profile[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

function identityFromProfile(profile: Record<string, any> | null): SsoIdentity | null {
  if (!profile) return null;
  const nameID = typeof profile.nameID === 'string' ? profile.nameID : null;
  const email = first(profile, EMAIL_CLAIMS) ?? (nameID && nameID.includes('@') ? nameID : null);
  if (!email) return null;
  const given = first(profile, ['givenName', 'firstName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']);
  const family = first(profile, ['sn', 'surname', 'lastName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']);
  const name = first(profile, NAME_CLAIMS) ?? ([given, family].filter(Boolean).join(' ') || null);
  let groups: string[] = [];
  for (const k of GROUP_CLAIMS) {
    const v = profile[k];
    if (Array.isArray(v)) groups = v.map(String);
    else if (typeof v === 'string' && v) groups = v.split(/[,;]/).map((g) => g.trim()).filter(Boolean);
    if (groups.length) break;
  }
  return { subject: nameID ?? email.toLowerCase(), email: email.toLowerCase(), name, emailVerified: true, groups };
}
