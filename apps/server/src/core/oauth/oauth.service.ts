import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from '../auth/services/token.service';
import { JwtOAuthPayload, JwtType } from '../auth/dto/jwt-payload';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { isUserDisabled } from '../../common/helpers';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  AUTH_METHODS,
  MAX_CLIENTS_PER_WORKSPACE,
  APP_REDIRECT_SCHEME,
  APP_SCOPE,
  OAUTH_SCOPES,
  OAuthScopeName,
  REFRESH_TOKEN_TTL_SECONDS,
} from './oauth.constants';
import { invalidClient, invalidGrant, invalidRequest, invalidScope, unsupportedGrant } from './oauth.errors';
import { ApproveAuthorizationDto, AuthorizeParamsDto, RegisterClientDto, TokenRequestDto } from './dto/oauth.dto';

export interface OAuthPrincipal {
  user: User;
  workspace: Workspace;
  oauth: { grantId: string; clientId: string; scopes: string[] };
}

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

// OAuth 2.1 authorization server for MCP clients (Claude, Cursor, ChatGPT,
// anything that speaks dynamic registration + authorization code with
// PKCE). Access tokens are short JWTs tied to a grant row so revoking the
// grant cuts them off; refresh tokens rotate on every use.
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);
  private readonly lastUsedTouched = new Map<string, number>();

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environment: EnvironmentService,
    private readonly tokens: TokenService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  // ---- discovery ----------------------------------------------------------

  issuer(): string {
    return this.environment.getAppUrl().replace(/\/+$/, '');
  }

  resourceUrl(): string {
    return `${this.issuer()}/mcp`;
  }

  authorizationServerMetadata() {
    const issuer = this.issuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/consent`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      revocation_endpoint: `${issuer}/api/oauth/revoke`,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://modelcontextprotocol.io/specification/basic/authorization',
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resourceUrl(),
      authorization_servers: [this.issuer()],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Docmore MCP server',
    };
  }

  // ---- clients ------------------------------------------------------------

  async registerClient(workspaceId: string, dto: RegisterClientDto) {
    const redirectUris = [...new Set(dto.redirect_uris.map((u) => u.trim()).filter(Boolean))];
    for (const uri of redirectUris) {
      if (!isAcceptableRedirectUri(uri)) {
        throw new OAuthRegistrationError('invalid_redirect_uri', `Redirect URI not allowed: ${uri}`);
      }
    }
    const grantTypes = (dto.grant_types?.length ? dto.grant_types : ['authorization_code', 'refresh_token']).filter((g) =>
      ['authorization_code', 'refresh_token'].includes(g),
    );
    if (!grantTypes.includes('authorization_code')) {
      throw new OAuthRegistrationError('invalid_client_metadata', 'Only the authorization_code grant is supported');
    }
    const authMethod = dto.token_endpoint_auth_method ?? 'none';
    if (!(AUTH_METHODS as readonly string[]).includes(authMethod)) {
      throw new OAuthRegistrationError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${authMethod}`);
    }
    const scopes = parseScopes(dto.scope) ?? [...OAUTH_SCOPES];
    if (scopes.includes(APP_SCOPE) && !redirectUris.every(isAppRedirectUri)) {
      throw new OAuthRegistrationError(
        'invalid_client_metadata',
        `The ${APP_SCOPE} scope is only for apps that return to ${APP_REDIRECT_SCHEME}//`,
      );
    }

    const count = await this.db
      .selectFrom('oauthClients')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (Number(count?.count ?? 0) >= MAX_CLIENTS_PER_WORKSPACE) {
      throw new OAuthRegistrationError('invalid_client_metadata', 'Too many registered clients');
    }

    const secret = authMethod === 'none' ? null : randomToken(32);
    const row = await this.db
      .insertInto('oauthClients')
      .values({
        workspaceId,
        name: (dto.client_name ?? '').trim().slice(0, 200) || 'Unnamed application',
        redirectUris: redirectUris as any,
        clientUri: safeHttpUrl(dto.client_uri),
        logoUri: safeHttpUrl(dto.logo_uri),
        grantTypes: grantTypes as any,
        scopes: scopes as any,
        tokenEndpointAuthMethod: authMethod,
        secretHash: secret ? sha256(secret) : null,
        isDynamic: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.log({
      event: AuditEvent.OAUTH_CLIENT_REGISTERED,
      resourceType: AuditResource.OAUTH_CLIENT,
      resourceId: row.id,
      changes: { after: { name: row.name, redirectUris, authMethod } },
    });
    return {
      client_id: row.id,
      client_id_issued_at: Math.floor(new Date(row.createdAt).getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: row.name,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      scope: scopes.join(' '),
      ...(row.clientUri ? { client_uri: row.clientUri } : {}),
      ...(row.logoUri ? { logo_uri: row.logoUri } : {}),
    };
  }

  // ---- authorization ------------------------------------------------------

  // What the consent page shows; also validates the request up front.
  async authorizeInfo(workspace: Workspace, params: AuthorizeParamsDto) {
    const { client, scopes } = await this.checkAuthorizeRequest(workspace.id, params);
    return {
      clientId: client.id,
      clientName: client.name,
      clientUri: client.clientUri,
      logoUri: client.logoUri,
      scopes,
      redirectUri: params.redirect_uri,
      verified: !client.isDynamic,
    };
  }

  // The user's decision, turned into the redirect the client expects.
  async approve(user: User, workspace: Workspace, dto: ApproveAuthorizationDto): Promise<{ redirectUrl: string }> {
    const { client, scopes } = await this.checkAuthorizeRequest(workspace.id, dto);
    const redirect = new URL(dto.redirect_uri);
    if (dto.state) redirect.searchParams.set('state', dto.state);

    if (!dto.approved) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'The user denied the request');
      return { redirectUrl: redirect.toString() };
    }
    const approved = (dto.approvedScopes?.length ? dto.approvedScopes : scopes).filter((s) => (scopes as string[]).includes(s));
    if (approved.length === 0) {
      throw invalidScope('At least one permission must be granted');
    }
    const code = randomToken(32);
    await this.db
      .insertInto('oauthAuthorizationCodes')
      .values({
        codeHash: sha256(code),
        clientId: client.id,
        userId: user.id,
        workspaceId: workspace.id,
        scopes: approved as any,
        redirectUri: dto.redirect_uri,
        codeChallenge: dto.code_challenge!,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
      })
      .execute();
    redirect.searchParams.set('code', code);
    return { redirectUrl: redirect.toString() };
  }

  // ---- tokens -------------------------------------------------------------

  async token(workspace: Workspace, dto: TokenRequestDto, basicAuth?: { clientId: string; secret: string } | null) {
    const clientId = dto.client_id ?? basicAuth?.clientId;
    if (!clientId) throw invalidClient('client_id is required');
    const client = await this.findClient(workspace.id, clientId);
    if (!client) throw invalidClient('Unknown client');
    await this.checkClientSecret(client, dto.client_secret ?? basicAuth?.secret);

    if (dto.grant_type === 'authorization_code') {
      return this.exchangeCode(workspace, client, dto);
    }
    if (dto.grant_type === 'refresh_token') {
      return this.refresh(workspace, client, dto);
    }
    throw unsupportedGrant(`Unsupported grant_type: ${dto.grant_type}`);
  }

  private async exchangeCode(workspace: Workspace, client: ClientRow, dto: TokenRequestDto) {
    if (!dto.code) throw invalidRequest('code is required');
    if (!dto.code_verifier) throw invalidRequest('code_verifier is required (PKCE)');
    const row = await this.db
      .selectFrom('oauthAuthorizationCodes')
      .selectAll()
      .where('codeHash', '=', sha256(dto.code))
      .executeTakeFirst();
    if (!row || row.clientId !== client.id || row.workspaceId !== workspace.id) {
      throw invalidGrant('Unknown or expired authorization code');
    }
    if (row.consumedAt || new Date(row.expiresAt).getTime() < Date.now()) {
      await this.db.deleteFrom('oauthAuthorizationCodes').where('id', '=', row.id).execute();
      throw invalidGrant('Authorization code already used or expired');
    }
    if (dto.redirect_uri && dto.redirect_uri !== row.redirectUri) {
      throw invalidGrant('redirect_uri does not match the authorization request');
    }
    const expected = row.codeChallenge ?? '';
    const actual = base64url(createHash('sha256').update(dto.code_verifier).digest());
    if (!expected || !safeEqual(expected, actual)) {
      throw invalidGrant('PKCE verification failed');
    }
    await this.db.updateTable('oauthAuthorizationCodes').set({ consumedAt: new Date() }).where('id', '=', row.id).execute();

    const user = await this.userRepo.findById(row.userId, workspace.id);
    if (!user || isUserDisabled(user)) throw invalidGrant('The user is no longer active');

    const scopes = asStringArray(row.scopes);
    const grant = await this.upsertGrant(workspace.id, user.id, client.id, scopes);
    return this.issueTokens(workspace, user, grant.id, scopes);
  }

  private async refresh(workspace: Workspace, client: ClientRow, dto: TokenRequestDto) {
    if (!dto.refresh_token) throw invalidRequest('refresh_token is required');
    const tokenRow = await this.db
      .selectFrom('oauthTokens')
      .selectAll()
      .where('refreshTokenHash', '=', sha256(dto.refresh_token))
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (!tokenRow) throw invalidGrant('Unknown refresh token');
    const grant = await this.db
      .selectFrom('oauthGrants')
      .selectAll()
      .where('id', '=', tokenRow.grantId)
      .executeTakeFirst();
    if (!grant || grant.clientId !== client.id) throw invalidGrant('Unknown refresh token');
    if (tokenRow.revokedAt) {
      // Reuse of a rotated refresh token: someone has a copy. Cut the grant.
      await this.revokeGrantRows(grant.id);
      throw invalidGrant('Refresh token was already used; access revoked');
    }
    if (grant.revokedAt || (tokenRow.refreshExpiresAt && new Date(tokenRow.refreshExpiresAt).getTime() < Date.now())) {
      throw invalidGrant('Refresh token expired or access revoked');
    }
    const user = await this.userRepo.findById(grant.userId, workspace.id);
    if (!user || isUserDisabled(user)) throw invalidGrant('The user is no longer active');

    await this.db.updateTable('oauthTokens').set({ revokedAt: new Date() }).where('id', '=', tokenRow.id).execute();
    const scopes = asStringArray(tokenRow.scopes);
    const requested = parseScopes(dto.scope);
    const granted = requested ? requested.filter((s) => scopes.includes(s)) : scopes;
    if (granted.length === 0) throw invalidScope('Requested scopes exceed the grant');
    return this.issueTokens(workspace, user, grant.id, granted);
  }

  private async issueTokens(workspace: Workspace, user: User, grantId: string, scopes: string[]) {
    const jti = randomUUID();
    const refreshToken = randomToken(32);
    const now = Date.now();
    await this.db
      .insertInto('oauthTokens')
      .values({
        grantId,
        workspaceId: workspace.id,
        accessTokenJti: jti,
        accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
        refreshTokenHash: sha256(refreshToken),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
        scopes: scopes as any,
      })
      .execute();
    const accessToken = await this.tokens.generateOAuthAccessToken(
      {
        sub: user.id,
        workspaceId: workspace.id,
        grantId,
        scope: scopes.join(' '),
        jti,
        type: JwtType.OAUTH_ACCESS,
      },
      { issuer: this.issuer(), audience: this.resourceUrl(), expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS },
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async revokeToken(workspace: Workspace, token: string) {
    const hash = sha256(token);
    const byRefresh = await this.db
      .updateTable('oauthTokens')
      .set({ revokedAt: new Date() })
      .where('refreshTokenHash', '=', hash)
      .where('workspaceId', '=', workspace.id)
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    if (Number(byRefresh.numUpdatedRows) > 0) return;
    // An access token: find its jti.
    try {
      const payload = (await this.tokens.verifyJwt(token, JwtType.OAUTH_ACCESS)) as JwtOAuthPayload;
      await this.db
        .updateTable('oauthTokens')
        .set({ revokedAt: new Date() })
        .where('accessTokenJti', '=', payload.jti)
        .where('workspaceId', '=', workspace.id)
        .execute();
    } catch {
      /* RFC 7009: unknown tokens are not an error */
    }
  }

  // ---- bearer validation (JwtStrategy) ------------------------------------

  async validateAccessToken(payload: JwtOAuthPayload, opts: { workspaceId?: string | null }): Promise<OAuthPrincipal> {
    if (opts.workspaceId && opts.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }
    const tokenRow = await this.db
      .selectFrom('oauthTokens')
      .select(['id', 'grantId', 'revokedAt', 'accessExpiresAt', 'scopes'])
      .where('accessTokenJti', '=', payload.jti)
      .where('workspaceId', '=', payload.workspaceId)
      .executeTakeFirst();
    if (!tokenRow || tokenRow.revokedAt || new Date(tokenRow.accessExpiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('Token revoked or expired');
    }
    const grant = await this.db
      .selectFrom('oauthGrants')
      .selectAll()
      .where('id', '=', tokenRow.grantId)
      .executeTakeFirst();
    if (!grant || grant.revokedAt || grant.id !== payload.grantId) {
      throw new UnauthorizedException('Access revoked');
    }
    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    const user = workspace ? await this.userRepo.findById(payload.sub, payload.workspaceId) : null;
    if (!workspace || !user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }
    void this.touchGrant(grant.id);
    return { user, workspace, oauth: { grantId: grant.id, clientId: grant.clientId, scopes: asStringArray(tokenRow.scopes) } };
  }

  // ---- grants (the user's connected apps) ---------------------------------

  async listGrants(user: User, workspace: Workspace): Promise<GrantView[]> {
    const rows = await this.db
      .selectFrom('oauthGrants')
      .innerJoin('oauthClients', 'oauthClients.id', 'oauthGrants.clientId')
      .select([
        'oauthGrants.id as id',
        'oauthGrants.scopes as scopes',
        'oauthGrants.createdAt as createdAt',
        'oauthGrants.lastUsedAt as lastUsedAt',
        'oauthClients.id as clientId',
        'oauthClients.name as clientName',
        'oauthClients.clientUri as clientUri',
        'oauthClients.logoUri as logoUri',
        'oauthClients.redirectUris as redirectUris',
      ])
      .where('oauthGrants.userId', '=', user.id)
      .where('oauthGrants.workspaceId', '=', workspace.id)
      .where('oauthGrants.revokedAt', 'is', null)
      .orderBy('oauthGrants.createdAt', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      clientUri: r.clientUri,
      logoUri: r.logoUri,
      redirectUris: asStringArray(r.redirectUris),
      scopes: asStringArray(r.scopes),
      createdAt: new Date(r.createdAt).toISOString(),
      lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
    }));
  }

  async revokeGrant(user: User, workspace: Workspace, grantId: string) {
    const grant = await this.db
      .selectFrom('oauthGrants')
      .selectAll()
      .where('id', '=', grantId)
      .where('userId', '=', user.id)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (!grant) throw new NotFoundException('Grant not found');
    await this.revokeGrantRows(grant.id);
    this.audit.log({
      event: AuditEvent.OAUTH_GRANT_REVOKED,
      resourceType: AuditResource.OAUTH_GRANT,
      resourceId: grant.id,
      changes: { before: { clientId: grant.clientId, scopes: grant.scopes } },
    });
  }

  // ---- internals ----------------------------------------------------------

  private async checkAuthorizeRequest(workspaceId: string, params: AuthorizeParamsDto) {
    if (params.response_type && params.response_type !== 'code') {
      throw invalidRequest('Only response_type=code is supported');
    }
    const client = await this.findClient(workspaceId, params.client_id);
    if (!client) throw invalidRequest('Unknown client');
    const redirectUris = asStringArray(client.redirectUris);
    if (!redirectUris.includes(params.redirect_uri)) {
      throw invalidRequest('redirect_uri is not registered for this client');
    }
    if (!params.code_challenge) {
      throw invalidRequest('code_challenge is required (PKCE S256)');
    }
    if (params.code_challenge_method && params.code_challenge_method !== 'S256') {
      throw invalidRequest('Only the S256 code_challenge_method is supported');
    }
    if (params.resource && normalizeUrl(params.resource) !== normalizeUrl(this.resourceUrl())) {
      throw invalidRequest(`Unknown resource; this server is ${this.resourceUrl()}`);
    }
    const requested = parseScopes(params.scope) ?? [...OAUTH_SCOPES];
    const allowed = asStringArray(client.scopes);
    const scopes = requested.filter((s) => isKnownScope(s) && allowed.includes(s));
    if (scopes.length === 0) throw invalidScope('No usable scope requested');
    return { client, scopes };
  }

  private async findClient(workspaceId: string, clientId: string): Promise<ClientRow | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return undefined;
    return this.db
      .selectFrom('oauthClients')
      .selectAll()
      .where('id', '=', clientId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  private async checkClientSecret(client: ClientRow, secret: string | undefined) {
    if (!client.secretHash) return;
    if (!secret || !safeEqual(client.secretHash, sha256(secret))) {
      throw invalidClient('Invalid client secret');
    }
  }

  // One grant row per user and client (the table enforces it): a live one
  // widens its scopes, a revoked one comes back with the new scopes.
  private async upsertGrant(workspaceId: string, userId: string, clientId: string, scopes: string[]) {
    const existing = await this.db
      .selectFrom('oauthGrants')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('clientId', '=', clientId)
      .executeTakeFirst();
    if (existing) {
      const merged = existing.revokedAt ? scopes : [...new Set([...asStringArray(existing.scopes), ...scopes])];
      const updated = await this.db
        .updateTable('oauthGrants')
        .set({ scopes: merged as any, revokedAt: null, updatedAt: new Date() })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (existing.revokedAt) {
        this.audit.log({
          event: AuditEvent.OAUTH_GRANT_CREATED,
          resourceType: AuditResource.OAUTH_GRANT,
          resourceId: updated.id,
          actorId: userId,
          changes: { after: { clientId, scopes } },
        } as any);
      }
      return updated;
    }
    const grant = await this.db
      .insertInto('oauthGrants')
      .values({ workspaceId, userId, clientId, scopes: scopes as any })
      .returningAll()
      .executeTakeFirstOrThrow();
    this.audit.log({
      event: AuditEvent.OAUTH_GRANT_CREATED,
      resourceType: AuditResource.OAUTH_GRANT,
      resourceId: grant.id,
      actorId: userId,
      changes: { after: { clientId, scopes } },
    } as any);
    return grant;
  }

  private async revokeGrantRows(grantId: string) {
    const now = new Date();
    await this.db.updateTable('oauthGrants').set({ revokedAt: now, updatedAt: now }).where('id', '=', grantId).execute();
    await this.db.updateTable('oauthTokens').set({ revokedAt: now }).where('grantId', '=', grantId).where('revokedAt', 'is', null).execute();
  }

  // Once a minute per grant is plenty for "last used".
  private async touchGrant(grantId: string) {
    const last = this.lastUsedTouched.get(grantId) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastUsedTouched.set(grantId, Date.now());
    try {
      await this.db.updateTable('oauthGrants').set({ lastUsedAt: new Date() }).where('id', '=', grantId).execute();
    } catch (err: any) {
      this.logger.debug(`lastUsedAt update failed: ${err?.message}`);
    }
  }
}

type ClientRow = {
  id: string;
  name: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: unknown;
  scopes: unknown;
  secretHash: string | null;
  isDynamic: boolean;
  tokenEndpointAuthMethod: string;
};

// RFC 7591 errors use their own vocabulary and a 400.
export class OAuthRegistrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// https on any host, http only on the loopback (local tools), or a custom
// app scheme (desktop clients); never something a browser would run.
export function isAcceptableRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }
  // Custom schemes are for native apps; browser-ish and transport schemes are not app callbacks.
  if (/^(javascript|data|vbscript|file|blob|ftp|ftps|ws|wss|mailto|tel):$/i.test(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol);
}

export function parseScopes(scope: string | undefined): OAuthScopeName[] | null {
  if (!scope?.trim()) return null;
  const list = [...new Set(scope.split(/[\s,]+/).filter(Boolean))];
  return list.filter((s): s is OAuthScopeName => isKnownScope(s));
}

function isKnownScope(scope: string): boolean {
  return (OAUTH_SCOPES as readonly string[]).includes(scope) || scope === APP_SCOPE;
}

function isAppRedirectUri(uri: string): boolean {
  try {
    return new URL(uri).protocol === APP_REDIRECT_SCHEME;
  } catch {
    return false;
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes: number): string {
  return base64url(randomBytes(bytes));
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
