import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { addYears, isAfter, isBefore } from 'date-fns';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { isUserDisabled } from '../../common/helpers';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  API_KEY_SCOPES,
  ApiKeyScope,
  CreateApiKeyDto,
} from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';

export const MAX_API_KEY_LIFETIME_YEARS = 3;

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly tokenService: TokenService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async list(user: User, workspace: Workspace, pagination: PaginationOptions) {
    if (pagination.adminView) {
      this.assertCanManage(user, workspace);
      return this.apiKeyRepo.paginate({ workspaceId: workspace.id }, pagination);
    }

    return this.apiKeyRepo.paginate(
      { workspaceId: workspace.id, creatorId: user.id },
      pagination,
    );
  }

  async create(user: User, workspace: Workspace, dto: CreateApiKeyDto) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API)) {
      throw new ForbiddenException();
    }

    const restrictToAdmins =
      (workspace.settings as any)?.api?.restrictToAdmins === true;
    if (
      restrictToAdmins &&
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API)
    ) {
      throw new ForbiddenException(
        'API key creation is restricted to admins in this workspace',
      );
    }

    const expiresAt = this.parseExpiry(dto.expiresAt);
    const scopes = normalizeScopes(dto.scopes);

    const apiKey = await this.apiKeyRepo.insert({
      name: dto.name.trim(),
      creatorId: user.id,
      workspaceId: workspace.id,
      expiresAt,
      scopes,
    });

    const expiresInSeconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    const token = await this.tokenService.generateApiToken({
      apiKeyId: apiKey.id,
      user,
      workspaceId: workspace.id,
      expiresIn: expiresInSeconds,
    });

    this.auditService.log({
      event: AuditEvent.API_KEY_CREATED,
      resourceType: AuditResource.API_KEY,
      resourceId: apiKey.id,
      metadata: { name: apiKey.name, scopes },
    });

    return { ...apiKey, creator: pickCreator(user), token };
  }

  async update(user: User, workspace: Workspace, dto: UpdateApiKeyDto) {
    const apiKey = await this.findOwnedOrManaged(user, workspace, dto.apiKeyId);

    const updated = await this.apiKeyRepo.update(apiKey.id, workspace.id, {
      name: dto.name.trim(),
    });

    this.auditService.log({
      event: AuditEvent.API_KEY_UPDATED,
      resourceType: AuditResource.API_KEY,
      resourceId: apiKey.id,
      metadata: { name: dto.name.trim() },
    });

    return { ...updated, creator: apiKey.creator };
  }

  async revoke(user: User, workspace: Workspace, apiKeyId: string) {
    const apiKey = await this.findOwnedOrManaged(user, workspace, apiKeyId);

    await this.apiKeyRepo.softDelete(apiKey.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.API_KEY_DELETED,
      resourceType: AuditResource.API_KEY,
      resourceId: apiKey.id,
      metadata: { name: apiKey.name },
    });
  }

  // Called by JwtStrategy for every request that carries an API key JWT.
  async validateApiKey(payload: JwtApiKeyPayload) {
    const apiKey = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );

    if (!apiKey || apiKey.creatorId !== payload.sub) {
      throw new UnauthorizedException('API key not found or revoked');
    }

    if (apiKey.expiresAt && isBefore(apiKey.expiresAt, new Date())) {
      throw new UnauthorizedException('API key has expired');
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException();
    }

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    this.apiKeyRepo.touchLastUsed(apiKey.id).catch((err) => {
      this.logger.debug(`failed to record API key use: ${err?.message}`);
    });

    return {
      user,
      workspace,
      apiKey: { id: apiKey.id, scopes: readScopes(apiKey.scopes) },
    };
  }

  private async findOwnedOrManaged(
    user: User,
    workspace: Workspace,
    apiKeyId: string,
  ) {
    const apiKey = await this.apiKeyRepo.findById(apiKeyId, workspace.id);
    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.creatorId !== user.id) {
      this.assertCanManage(user, workspace);
    }

    return apiKey;
  }

  private assertCanManage(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API)) {
      throw new ForbiddenException();
    }
  }

  private parseExpiry(value: string): Date {
    const expiresAt = new Date(value);
    const now = new Date();

    if (Number.isNaN(expiresAt.getTime()) || !isAfter(expiresAt, now)) {
      throw new BadRequestException('Expiration date must be in the future');
    }

    if (isAfter(expiresAt, addYears(now, MAX_API_KEY_LIFETIME_YEARS))) {
      throw new BadRequestException(
        `API keys can live at most ${MAX_API_KEY_LIFETIME_YEARS} years`,
      );
    }

    return expiresAt;
  }
}

export function normalizeScopes(scopes?: ApiKeyScope[]): ApiKeyScope[] {
  const wanted = new Set<ApiKeyScope>(
    (scopes ?? [...API_KEY_SCOPES]).filter((scope) =>
      API_KEY_SCOPES.includes(scope),
    ),
  );
  if (wanted.size === 0) {
    throw new BadRequestException('Choose at least one permission');
  }
  // Write access always includes read access.
  if (wanted.has('write')) {
    wanted.add('read');
  }
  return API_KEY_SCOPES.filter((scope) => wanted.has(scope));
}

export function readScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string');
  }
  if (typeof value === 'string') {
    try {
      return readScopes(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function pickCreator(user: User) {
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
  };
}
