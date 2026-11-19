import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { BaseService } from '../services/base.service';
import { BaseCsvExportService } from '../services/base-csv-export.service';
import { BasePageResolverService } from '../services/base-page-resolver.service';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { CreateBaseDto } from '../dto/create-base.dto';
import { ConvertBaseDto } from '../dto/convert-base.dto';
import { UpdateBaseDto } from '../dto/update-base.dto';
import { BaseIdDto } from '../dto/base.dto';
import { ExportBaseCsvDto } from '../dto/export-base.dto';
import { ResolvePagesDto } from '../dto/resolve-pages.dto';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import { SpaceIdDto } from '../../space/dto/space-id.dto';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import {
  AuditEvent,
  AuditLogPayload,
  AuditResource,
} from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { FileInterceptor } from '../../../common/interceptors/file.interceptor';
import { BaseCsvImportService } from '../import/base-csv-import.service';
import { CSV_IMPORT_LIMITS } from '../import/base-csv-import.schema';
import { assertBaseUnlocked } from '../services/base-lock';
import { BaseVisibilityService } from '../services/base-visibility.service';

@UseGuards(JwtAuthGuard)
@Controller('bases')
export class BaseController {
  constructor(
    private readonly visibility: BaseVisibilityService,
    private readonly baseService: BaseService,
    private readonly baseCsvExportService: BaseCsvExportService,
    private readonly basePageResolverService: BasePageResolverService,
    private readonly baseRepo: BaseRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageRepo: PageRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly baseCsvImportService: BaseCsvImportService,
  ) {}

  private audit(
    event: AuditLogPayload['event'],
    base: { id: string; spaceId: string },
    metadata: Record<string, unknown> = {},
  ) {
    this.auditService.log({
      event,
      resourceType: AuditResource.BASE,
      resourceId: base.id,
      spaceId: base.spaceId,
      metadata,
    });
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('create')
  async create(
    @Body() dto: CreateBaseDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // One endpoint, two modes:
    //   - parentPageId set → inline embed inside that page. Derive
    //     spaceId/workspaceId from the parent and gate on Edit access
    //     to the parent (same check the editor uses for any other
    //     content the user adds while editing). Seed two extra text
    //     columns + one row so the freshly-inserted base looks like
    //     a typical database on first paint.
    //   - parentPageId unset → standalone base. Gate on space-level
    //     Create, Page (the same check the page controller uses for
    //     its own create endpoint).
    if (dto.parentPageId) {
      const parent = await this.pageRepo.findById(dto.parentPageId);
      if (!parent) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parent, user);

      const base = await this.baseService.create(
        user.id,
        parent.workspaceId,
        {
          ...dto,
          spaceId: parent.spaceId,
        },
        { extraTextProperties: 2, defaultRows: 1 },
      );
      this.audit(AuditEvent.BASE_CREATED, base, {
        parentPageId: parent.id,
        template: dto.template ?? null,
      });
      return base;
    }

    if (!dto.spaceId) {
      throw new BadRequestException('spaceId or parentPageId is required');
    }

    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const base = await this.baseService.create(user.id, workspace.id, dto);
    this.audit(AuditEvent.BASE_CREATED, base, {
      template: dto.template ?? null,
    });
    return base;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('convert')
  async convert(@Body() dto: ConvertBaseDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanEdit(page, user);
    const base = await this.baseService.convert(
      user.id,
      page.workspaceId,
      page.id,
      dto.template,
    );
    this.audit(AuditEvent.BASE_CONVERTED, base, {
      template: dto.template ?? null,
    });
    return base;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post('info')
  async getBase(@Body() dto: BaseIdDto, @AuthUser() user: User) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    const permissions =
      await this.pageAccessService.validateCanViewWithPermissions(base, user);

    const info = await this.baseService.getBaseInfo(dto.pageId);
    const level = await this.visibility.levelFor(user, base.spaceId);
    const hidden = this.visibility.hiddenIds(((info as any).properties ?? []) as any, level);
    return {
      ...this.visibility.stripBaseInfo(info as any, hidden),
      permissions: { ...permissions, canManage: level === 'admins', visibility: level },
    };
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('update')
  async update(@Body() dto: UpdateBaseDto, @AuthUser() user: User) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);

    return this.baseService.update(dto);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('delete')
  async delete(@Body() dto: BaseIdDto, @AuthUser() user: User) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);

    await this.baseService.delete(dto.pageId);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post()
  async list(
    @Body() dto: SpaceIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    // Same Page-subject check the page controller's list-equivalents
    // use; a base is a page (isBase=true) so reader access aligns.
    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const result = await this.baseService.listBySpaceId(dto.spaceId, pagination);
    const accessible = await this.pagePermissionRepo.filterAccessiblePageIds({
      pageIds: result.items.map((b) => b.id),
      userId: user.id,
    });
    const accessibleSet = new Set(accessible);
    return {
      ...result,
      items: result.items.filter((b) => accessibleSet.has(b.id)),
    };
  }

  // Multipart: pageId, spec (JSON), file (JSONL built by the client).
  @UseInterceptors(FileInterceptor)
  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('import-csv')
  async importCsv(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    let file: any = null;
    try {
      file = await req.file({
        limits: { fileSize: CSV_IMPORT_LIMITS.maxFileBytes, fields: 4, files: 1 },
      });
    } catch (err: any) {
      if (err?.statusCode === 413) {
        throw new PayloadTooLargeException('Import file is too large');
      }
      throw new BadRequestException('Failed to upload file');
    }
    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }
    const pageId = file.fields?.pageId?.value;
    const spec = this.baseCsvImportService.parseSpec(file.fields?.spec?.value);
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }
    const base = await this.baseRepo.findById(pageId);
    if (!base || base.workspaceId !== workspace.id) {
      throw new NotFoundException('Base not found');
    }
    await this.pageAccessService.validateCanEdit(base, user);
    assertBaseUnlocked(base);
    const task = await this.baseCsvImportService.start(base, user, spec, file);
    this.audit(AuditEvent.BASE_IMPORTED, base, {
      fileTaskId: task.id,
      fileName: spec.fileName,
      rowCount: spec.rowCount,
      status: 'queued',
    });
    return task;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post('export-csv')
  async exportCsv(
    @Body() dto: ExportBaseCsvDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanView(base, user);
    await this.pageAccessService.validateCanExport(base.spaceId, workspace.id);

    this.audit(AuditEvent.BASE_EXPORTED, base, { format: 'csv' });
    await this.baseCsvExportService.streamBaseAsCsv(
      dto.pageId,
      workspace.id,
      res,
      { hidden: await this.visibility.hiddenFor(user, base) },
    );
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post('pages/expand')
  async resolvePages(
    @Body() dto: ResolvePagesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const items = await this.basePageResolverService.resolvePages(
      dto.pageIds,
      workspace.id,
      user.id,
    );
    return { items };
  }

}
