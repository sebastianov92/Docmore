import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuthProvider,
  UpdatableAuthProvider,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import { AuthProviderRepo } from '@docmost/db/repos/auth-provider/auth-provider.repo';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../integrations/encryption/encryption.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { CreateSsoProviderDto, UpdateSsoProviderDto } from './dto/sso.dto';
import { toProviderView } from './sso.utils';

// Admin side of single sign-on: the provider records. The login flow itself
// lives in OidcService.
@Injectable()
export class SsoService {
  constructor(
    private readonly authProviderRepo: AuthProviderRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly encryptionService: EncryptionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async list(user: User, workspace: Workspace) {
    this.assertAdmin(user, workspace);
    const items = await this.authProviderRepo.list(workspace.id);
    return {
      items: items.map((item) => toProviderView(item)),
      meta: {
        limit: items.length,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    };
  }

  async info(user: User, workspace: Workspace, providerId: string) {
    this.assertAdmin(user, workspace);
    const provider = await this.getProvider(providerId, workspace.id, true);
    return toProviderView(provider);
  }

  async create(user: User, workspace: Workspace, dto: CreateSsoProviderDto) {
    this.assertAdmin(user, workspace);

    const provider = await this.authProviderRepo.insert({
      type: dto.type,
      name: dto.name || 'OpenID Connect',
      isEnabled: false,
      allowSignup: false,
      groupSync: false,
      creatorId: user.id,
      workspaceId: workspace.id,
    });

    this.auditService.log({
      event: AuditEvent.SSO_PROVIDER_CREATED,
      resourceType: AuditResource.SSO_PROVIDER,
      resourceId: provider.id,
      changes: { after: { name: provider.name, type: provider.type } },
    });

    return toProviderView(provider);
  }

  async update(user: User, workspace: Workspace, dto: UpdateSsoProviderDto) {
    this.assertAdmin(user, workspace);
    const current = await this.getProvider(dto.providerId, workspace.id, true);

    const changes: UpdatableAuthProvider = {};
    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.oidcIssuer !== undefined) changes.oidcIssuer = dto.oidcIssuer;
    if (dto.oidcClientId !== undefined) changes.oidcClientId = dto.oidcClientId;
    if (dto.oidcClientSecret !== undefined) {
      changes.oidcClientSecret = this.encryptionService.encrypt(
        dto.oidcClientSecret,
        EncryptionPurpose.SSO_SECRETS,
      );
    }
    if (dto.samlUrl !== undefined) changes.samlUrl = dto.samlUrl;
    if (dto.samlCertificate !== undefined) changes.samlCertificate = dto.samlCertificate.trim();
    if (dto.allowSignup !== undefined) changes.allowSignup = dto.allowSignup;
    if (dto.groupSync !== undefined) changes.groupSync = dto.groupSync;
    if (dto.isEnabled !== undefined) changes.isEnabled = dto.isEnabled;

    const next = { ...current, ...changes };

    if (next.isEnabled) {
      const missing = (
        next.type === 'saml'
          ? [!next.samlUrl && 'sign-in URL', !next.samlCertificate && 'certificate']
          : [
              !next.oidcIssuer && 'issuer URL',
              !next.oidcClientId && 'client ID',
              !next.oidcClientSecret && 'client secret',
            ]
      ).filter(Boolean);
      if (missing.length > 0) {
        throw new BadRequestException(
          `Fill in the ${missing.join(', ')} before enabling this provider`,
        );
      }
    }

    if (current.isEnabled && dto.isEnabled === false) {
      await this.assertNotLastEnforcedProvider(workspace, current.id);
    }

    if (Object.keys(changes).length === 0) {
      return toProviderView(current);
    }

    const updated = await this.authProviderRepo.update(
      current.id,
      workspace.id,
      changes,
    );

    const tracked: Array<keyof UpdatableAuthProvider> = [
      'name',
      'oidcIssuer',
      'oidcClientId',
      'samlUrl',
      'allowSignup',
      'isEnabled',
      'groupSync',
    ];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of tracked) {
      if (field in changes && current[field] !== updated[field]) {
        before[field] = current[field];
        after[field] = updated[field];
      }
    }
    if (dto.oidcClientSecret !== undefined) {
      after.oidcClientSecret = '[updated]';
    }

    this.auditService.log({
      event: AuditEvent.SSO_PROVIDER_UPDATED,
      resourceType: AuditResource.SSO_PROVIDER,
      resourceId: updated.id,
      changes: { before, after },
    });

    return toProviderView(updated);
  }

  async delete(user: User, workspace: Workspace, providerId: string) {
    this.assertAdmin(user, workspace);
    const provider = await this.getProvider(providerId, workspace.id);

    if (provider.isEnabled) {
      await this.assertNotLastEnforcedProvider(workspace, provider.id);
    }

    await this.authProviderRepo.delete(provider.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.SSO_PROVIDER_DELETED,
      resourceType: AuditResource.SSO_PROVIDER,
      resourceId: provider.id,
      changes: { before: { name: provider.name, type: provider.type } },
    });
  }

  private async getProvider(
    providerId: string,
    workspaceId: string,
    includeSecret = false,
  ): Promise<AuthProvider> {
    const provider = await this.authProviderRepo.findById(
      providerId,
      workspaceId,
      { includeSecret },
    );
    if (!provider) {
      throw new NotFoundException('SSO provider not found');
    }
    return provider;
  }

  // With SSO enforced, removing the last working provider would lock every
  // admin out of the workspace.
  private async assertNotLastEnforcedProvider(
    workspace: Workspace,
    providerId: string,
  ) {
    if (!workspace.enforceSso) return;
    const others = await this.authProviderRepo.countEnabled(workspace.id, {
      excludeId: providerId,
    });
    if (others === 0) {
      throw new BadRequestException(
        'Turn off SSO enforcement before disabling or deleting the last active provider',
      );
    }
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
  }
}
