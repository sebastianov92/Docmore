import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { emptyCursorPaginationResult } from '@docmost/db/pagination/cursor-pagination';
import {
  Template,
  UpdatableTemplate,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { PageService } from '../page/services/page.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import { jsonToText } from '../../collaboration/collaboration.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/template.dto';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async list(user: User, workspace: Workspace, dto: ListTemplatesDto) {
    const accessible = await this.accessibleSpaceIds(user, workspace);

    // A space filter means "usable in this space": its own templates plus the
    // workspace-wide ones. A space the user cannot see yields nothing at all.
    if (dto.spaceId) {
      if (!accessible.includes(dto.spaceId)) {
        return emptyCursorPaginationResult<Template>(dto.limit);
      }
      return this.templateRepo.findTemplates(workspace.id, [dto.spaceId], dto);
    }

    return this.templateRepo.findTemplates(workspace.id, accessible, dto);
  }

  async info(user: User, workspace: Workspace, templateId: string) {
    return this.findReadable(user, workspace, templateId);
  }

  async create(user: User, workspace: Workspace, dto: CreateTemplateDto) {
    const spaceId = dto.spaceId || null;
    await this.assertCanCreateIn(user, workspace, spaceId);

    const { id } = await this.templateRepo.insertTemplate({
      title: dto.title.trim(),
      description: dto.description ?? null,
      icon: dto.icon ?? null,
      content: (dto.content as any) ?? null,
      textContent: dto.content ? jsonToText(dto.content as any) : null,
      spaceId,
      workspaceId: workspace.id,
      creatorId: user.id,
      lastUpdatedById: user.id,
    });

    this.auditService.log({
      event: AuditEvent.TEMPLATE_CREATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: id,
      metadata: { title: dto.title.trim(), spaceId },
    });

    return this.templateRepo.findById(id, workspace.id, { includeContent: true });
  }

  async update(user: User, workspace: Workspace, dto: UpdateTemplateDto) {
    const template = await this.findReadable(user, workspace, dto.templateId);
    this.assertCanManage(user, workspace, template);

    const changes: UpdatableTemplate = { lastUpdatedById: user.id };

    if (dto.title !== undefined) {
      changes.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      changes.description = dto.description;
    }
    if (dto.icon !== undefined) {
      changes.icon = dto.icon;
    }
    if (dto.content !== undefined) {
      changes.content = dto.content as any;
      changes.textContent = jsonToText(dto.content as any);
    }
    if (dto.spaceId !== undefined) {
      const spaceId = dto.spaceId || null;
      if (spaceId !== template.spaceId) {
        // Moving a template is creating it in the new scope.
        await this.assertCanCreateIn(user, workspace, spaceId);
        changes.spaceId = spaceId;
      }
    }

    await this.templateRepo.updateTemplate(changes, template.id, workspace.id);
    return this.templateRepo.findById(template.id, workspace.id, {
      includeContent: true,
    });
  }

  async delete(user: User, workspace: Workspace, templateId: string) {
    const template = await this.findReadable(user, workspace, templateId);
    this.assertCanManage(user, workspace, template);

    await this.templateRepo.deleteTemplate(template.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.TEMPLATE_DELETED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      metadata: { title: template.title, spaceId: template.spaceId },
    });
  }

  // Creates a page from the template, with the same checks as creating a blank page.
  async use(user: User, workspace: Workspace, dto: UseTemplateDto) {
    const template = await this.findReadable(user, workspace, dto.templateId);

    if (dto.parentPageId) {
      const parentPage = await this.pageRepo.findById(dto.parentPageId);
      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== dto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, user);
    } else {
      const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    return this.pageService.create(user.id, workspace.id, {
      title: template.title ?? undefined,
      icon: template.icon ?? undefined,
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId,
      content: (template.content as any) ?? undefined,
      format: 'json',
    });
  }

  private isWorkspaceAdmin(user: User, workspace: Workspace): boolean {
    return this.workspaceAbility
      .createForUser(user, workspace)
      .can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  }

  private membersMayManage(workspace: Workspace): boolean {
    return (
      (workspace.settings as any)?.templates?.allowMemberTemplates === true
    );
  }

  private async accessibleSpaceIds(
    user: User,
    workspace: Workspace,
  ): Promise<string[]> {
    if (this.isWorkspaceAdmin(user, workspace)) {
      const spaces = await this.db
        .selectFrom('spaces')
        .select('id')
        .where('workspaceId', '=', workspace.id)
        .execute();
      return spaces.map((space) => space.id);
    }
    return this.spaceMemberRepo.getUserSpaceIds(user.id);
  }

  private async findReadable(
    user: User,
    workspace: Workspace,
    templateId: string,
  ): Promise<Template> {
    const template = await this.templateRepo.findById(templateId, workspace.id, {
      includeContent: true,
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    if (template.spaceId) {
      const spaceIds = await this.accessibleSpaceIds(user, workspace);
      if (!spaceIds.includes(template.spaceId)) {
        throw new NotFoundException('Template not found');
      }
    }
    return template;
  }

  private assertCanManage(user: User, workspace: Workspace, template: Template) {
    if (this.isWorkspaceAdmin(user, workspace)) {
      return;
    }
    if (
      template.spaceId &&
      template.creatorId === user.id &&
      this.membersMayManage(workspace)
    ) {
      return;
    }
    throw new ForbiddenException('You cannot change this template');
  }

  private async assertCanCreateIn(
    user: User,
    workspace: Workspace,
    spaceId: string | null,
  ) {
    const admin = this.isWorkspaceAdmin(user, workspace);

    if (!spaceId) {
      if (!admin) {
        throw new ForbiddenException(
          'Only workspace admins can create workspace templates',
        );
      }
      return;
    }

    const space = await this.db
      .selectFrom('spaces')
      .select('id')
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (!space) {
      throw new NotFoundException('Space not found');
    }

    if (admin) {
      return;
    }
    if (!this.membersMayManage(workspace)) {
      throw new ForbiddenException(
        'Members cannot create templates in this workspace',
      );
    }
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('You cannot create templates in this space');
    }
  }
}
