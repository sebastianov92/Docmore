import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as client from 'openid-client';
import { randomBytes } from 'crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { AuthProvider, User, Workspace } from '@docmost/db/types/entity.types';
import { AuthProviderRepo } from '@docmost/db/repos/auth-provider/auth-provider.repo';
import { AuthAccountRepo } from '@docmost/db/repos/auth-provider/auth-account.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../integrations/encryption/encryption.service';
import { TokenService } from '../auth/services/token.service';
import { AuthService } from '../auth/services/auth.service';
import { WorkspaceService } from '../workspace/services/workspace.service';
import { JwtSsoStatePayload, JwtType } from '../auth/dto/jwt-payload';
import { validateAllowedEmail } from '../auth/auth.util';
import { isUserDisabled } from '../../common/helpers';
import { UserRole } from '../../common/helpers/types/permission';
import {
  getWorkspaceDefaultLocale,
  getWorkspaceDefaultPageEditMode,
} from '../workspace/workspace.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  buildOidcCallbackUrl,
  identityFromClaims,
  isHttpIssuer,
  SsoIdentity,
} from './sso.utils';

const DISCOVERY_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_SECONDS = 15;

interface CachedConfiguration {
  config: client.Configuration;
  expiresAt: number;
  fingerprint: string;
}

export interface OidcLoginStart {
  authorizationUrl: string;
  stateToken: string;
}

// OpenID Connect login against a provider configured in the workspace:
// authorization code flow with PKCE, account linking by email, optional
// sign-up and group sync. Errors thrown here carry messages safe to show on
// the login page.
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly configurations = new Map<string, CachedConfiguration>();

  constructor(
    private readonly authProviderRepo: AuthProviderRepo,
    private readonly authAccountRepo: AuthAccountRepo,
    private readonly userRepo: UserRepo,
    private readonly groupRepo: GroupRepo,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly workspaceService: WorkspaceService,
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
    private readonly encryptionService: EncryptionService,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getEnabledProvider(
    providerId: string,
    workspaceId: string,
  ): Promise<AuthProvider> {
    const provider = await this.authProviderRepo.findById(
      providerId,
      workspaceId,
      { includeSecret: true },
    );
    if (!provider || provider.type !== 'oidc' || !provider.isEnabled) {
      throw new NotFoundException('This sign-in method is not available');
    }
    return provider;
  }

  async startLogin(
    provider: AuthProvider,
    workspace: Workspace,
    redirect: string | null,
  ): Promise<OidcLoginStart> {
    const config = await this.getConfiguration(provider);

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const scopes = ['openid', 'email', 'profile'];
    if (provider.groupSync) scopes.push('groups');

    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl(provider.id),
      scope: scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    const stateToken = await this.tokenService.generateSsoStateToken({
      providerId: provider.id,
      workspaceId: workspace.id,
      state,
      nonce,
      codeVerifier,
      redirect,
    });

    return { authorizationUrl: authorizationUrl.href, stateToken };
  }

  // Returns the session token to put in the auth cookie plus where to send
  // the browser afterwards.
  async completeLogin(
    provider: AuthProvider,
    workspace: Workspace,
    callbackUrl: URL,
    stateToken: string | undefined,
  ): Promise<{ authToken: string; redirect: string | null }> {
    const stateClaims = await this.verifyState(stateToken, provider, workspace);
    const config = await this.getConfiguration(provider);

    let tokens: client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: stateClaims.codeVerifier,
        expectedNonce: stateClaims.nonce,
        expectedState: stateClaims.state,
        idTokenExpected: true,
      });
    } catch (err) {
      this.logger.warn(
        `OIDC code exchange failed for provider ${provider.id}: ${describeError(err)}`,
      );
      throw new UnauthorizedException(
        'The identity provider rejected the sign-in. Please try again.',
      );
    }

    let identity = identityFromClaims(tokens.claims());
    if (!identity || (provider.groupSync && identity.groups.length === 0)) {
      // Some providers only put email or groups in the userinfo response.
      const merged = await this.mergeUserInfo(config, tokens, identity);
      identity = merged ?? identity;
    }
    if (!identity) {
      throw new UnauthorizedException(
        'The identity provider did not share an email address for your account',
      );
    }

    const user = await this.resolveUser(provider, workspace, identity);

    if (provider.groupSync) {
      await this.syncGroups(user, workspace, identity.groups);
    }

    const authToken = await this.authService.completeLogin(
      user,
      workspace.id,
      'oidc',
    );
    return { authToken, redirect: stateClaims.redirect };
  }

  callbackUrl(providerId: string): string {
    return buildOidcCallbackUrl(this.environmentService.getAppUrl(), providerId);
  }

  private async verifyState(
    stateToken: string | undefined,
    provider: AuthProvider,
    workspace: Workspace,
  ): Promise<JwtSsoStatePayload> {
    if (!stateToken) {
      throw new BadRequestException(
        'Your sign-in session expired. Please start again.',
      );
    }
    let payload: JwtSsoStatePayload;
    try {
      payload = await this.tokenService.verifyJwt(stateToken, JwtType.SSO_STATE);
    } catch {
      throw new BadRequestException(
        'Your sign-in session expired. Please start again.',
      );
    }
    if (
      payload.providerId !== provider.id ||
      payload.workspaceId !== workspace.id
    ) {
      throw new BadRequestException('Sign-in request does not match');
    }
    return payload;
  }

  private async mergeUserInfo(
    config: client.Configuration,
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    identity: SsoIdentity | null,
  ): Promise<SsoIdentity | null> {
    const subject = tokens.claims()?.sub;
    if (!subject || !config.serverMetadata().userinfo_endpoint) {
      return identity;
    }
    try {
      const info = await client.fetchUserInfo(
        config,
        tokens.access_token,
        subject,
      );
      const fromInfo = identityFromClaims({ ...tokens.claims(), ...info });
      if (!fromInfo) return identity;
      return {
        ...fromInfo,
        groups:
          fromInfo.groups.length > 0 ? fromInfo.groups : identity?.groups ?? [],
      };
    } catch (err) {
      this.logger.warn(`OIDC userinfo request failed: ${describeError(err)}`);
      return identity;
    }
  }

  private async resolveUser(
    provider: AuthProvider,
    workspace: Workspace,
    identity: SsoIdentity,
  ): Promise<User> {
    const linked = await this.authAccountRepo.findByProviderUser(
      provider.id,
      identity.subject,
    );
    if (linked) {
      const user = await this.userRepo.findById(linked.userId, workspace.id);
      if (!user) {
        throw new UnauthorizedException('Your account no longer exists');
      }
      this.assertActive(user);
      return user;
    }

    const existing = await this.userRepo.findByEmail(
      identity.email,
      workspace.id,
    );
    if (existing) {
      this.assertActive(existing);
      const otherLink = await this.authAccountRepo.findByUser(
        existing.id,
        provider.id,
      );
      if (otherLink) {
        throw new UnauthorizedException(
          'Your email is already linked to a different account at this provider',
        );
      }
      await this.authAccountRepo.insert({
        userId: existing.id,
        providerUserId: identity.subject,
        authProviderId: provider.id,
        workspaceId: workspace.id,
      });
      return existing;
    }

    if (!provider.allowSignup) {
      throw new ForbiddenException(
        'No account exists for this email. Ask an administrator for an invitation.',
      );
    }

    validateAllowedEmail(identity.email, workspace);
    return this.createUser(provider, workspace, identity);
  }

  private assertActive(user: User) {
    if (isUserDisabled(user)) {
      throw new ForbiddenException('Your account has been deactivated');
    }
  }

  // Creates the member, honouring a pending invitation for the same email so
  // the invited role and groups apply and the invitation is consumed.
  private async createUser(
    provider: AuthProvider,
    workspace: Workspace,
    identity: SsoIdentity,
  ): Promise<User> {
    const user = await executeTx(this.db, async (trx: KyselyTransaction) => {
      const invitation = await trx
        .selectFrom('workspaceInvitations')
        .select(['id', 'role', 'groupIds', 'invitedById'])
        .where('workspaceId', '=', workspace.id)
        .where('email', '=', identity.email)
        .where('expiresAt', '>', new Date())
        .executeTakeFirst();

      const role = (invitation?.role as UserRole) ?? undefined;

      const created = await this.userRepo.insertUser(
        {
          name: identity.name ?? identity.email.split('@')[0],
          email: identity.email,
          // Nobody knows this password; the account signs in through SSO.
          password: randomBytes(32).toString('hex'),
          hasGeneratedPassword: true,
          emailVerifiedAt: new Date(),
          invitedById: invitation?.invitedById ?? null,
          workspaceId: workspace.id,
        },
        trx,
        {
          pageEditMode: getWorkspaceDefaultPageEditMode(workspace),
          locale: getWorkspaceDefaultLocale(workspace),
        },
      );

      await this.workspaceService.addUserToWorkspace(
        created.id,
        workspace.id,
        role,
        trx,
      );
      await this.groupUserRepo.addUserToDefaultGroup(
        created.id,
        workspace.id,
        trx,
      );

      if (invitation) {
        if (invitation.groupIds?.length) {
          const validGroups = await trx
            .selectFrom('groups')
            .select(['id'])
            .where('id', 'in', invitation.groupIds)
            .where('workspaceId', '=', workspace.id)
            .execute();
          if (validGroups.length > 0) {
            await trx
              .insertInto('groupUsers')
              .values(
                validGroups.map((group) => ({
                  userId: created.id,
                  groupId: group.id,
                })),
              )
              .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
              .execute();
          }
        }
        await trx
          .deleteFrom('workspaceInvitations')
          .where('id', '=', invitation.id)
          .execute();
      }

      await this.authAccountRepo.insert(
        {
          userId: created.id,
          providerUserId: identity.subject,
          authProviderId: provider.id,
          workspaceId: workspace.id,
        },
        trx,
      );

      return created;
    });

    this.auditService.log({
      event: AuditEvent.USER_CREATED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      changes: {
        after: { name: user.name, email: user.email, role: user.role },
      },
      metadata: { source: 'sso', providerId: provider.id },
    });

    return this.userRepo.findById(user.id, workspace.id);
  }

  // Add-only: the user joins every group named by the provider (created on
  // demand). Memberships granted inside Docmore are never removed here.
  private async syncGroups(user: User, workspace: Workspace, names: string[]) {
    for (const name of names) {
      try {
        let group = await this.groupRepo.findByName(name, workspace.id);
        if (!group) {
          group = await this.groupRepo.insertGroup({
            name,
            isDefault: false,
            isExternal: true,
            creatorId: null,
            workspaceId: workspace.id,
          });
        }
        if (group.isDefault) continue;
        await this.db
          .insertInto('groupUsers')
          .values({ userId: user.id, groupId: group.id })
          .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
          .execute();
      } catch (err) {
        this.logger.warn(
          `Group sync skipped "${name}" for ${user.id}: ${describeError(err)}`,
        );
      }
    }
  }

  private async getConfiguration(
    provider: AuthProvider,
  ): Promise<client.Configuration> {
    const fingerprint = `${provider.oidcIssuer}|${provider.oidcClientId}|${provider.updatedAt?.toISOString?.() ?? ''}`;
    const cached = this.configurations.get(provider.id);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      cached.expiresAt > Date.now()
    ) {
      return cached.config;
    }

    if (!provider.oidcIssuer || !provider.oidcClientId || !provider.oidcClientSecret) {
      throw new BadRequestException('This SSO provider is not fully configured');
    }

    const secret = this.encryptionService.decrypt(
      provider.oidcClientSecret,
      EncryptionPurpose.SSO_SECRETS,
    );

    let config: client.Configuration;
    try {
      config = await client.discovery(
        new URL(provider.oidcIssuer),
        provider.oidcClientId,
        secret,
        undefined,
        {
          timeout: DISCOVERY_TIMEOUT_SECONDS,
          execute: isHttpIssuer(provider.oidcIssuer)
            ? [client.allowInsecureRequests]
            : [],
        },
      );
    } catch (err) {
      this.logger.error(
        `OIDC discovery failed for ${provider.oidcIssuer}: ${describeError(err)}`,
      );
      throw new BadRequestException(
        'Could not reach the identity provider. Check the issuer URL.',
      );
    }

    this.configurations.set(provider.id, {
      config,
      fingerprint,
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
    });
    return config;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const extra = (err as any).cause?.message ?? (err as any).error_description;
    return extra ? `${err.message} (${extra})` : err.message;
  }
  return String(err);
}
