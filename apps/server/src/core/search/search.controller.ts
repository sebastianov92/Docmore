import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
  Inject,
} from '@nestjs/common';
import { SearchService } from './search.service';
import {
  SearchDTO,
  SearchPublicSpaceDTO,
  SearchShareDTO,
  SearchSuggestionDTO,
} from './dto/search.dto';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { Public } from 'src/common/decorators/public.decorator';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ModuleRef } from '@nestjs/core';
import { PageSearchService } from '../../integrations/typesense/page-search.service';
import { PublicSpaceService } from '../public-space/public-space.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { ShareService } from '../share/share.service';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { BaseRowSearchService } from '../base/search/base-row-search.service';
import {  AUDIT_SERVICE,  IAuditService, } from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';

@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  private readonly logger = new Logger(SearchController.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly environmentService: EnvironmentService,
    private readonly publicSpaceService: PublicSpaceService,
    private readonly pageRepo: PageRepo,
    private readonly shareService: ShareService,
    private readonly shareRepo: ShareRepo,
    private moduleRef: ModuleRef,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  @OAuthScope('read')
  async pageSearch(
    @Body() searchDto: SearchDTO,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    delete searchDto.shareId;

    if (searchDto.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        searchDto.spaceId,
      );

      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    // Admin content search: owners and admins may look across every space.
    // Audited, and always served by Postgres (Typesense indexes by member).
    const allSpaces =
      searchDto.allSpaces === true &&
      !searchDto.spaceId &&
      (user.role === UserRole.OWNER || user.role === UserRole.ADMIN);
    if (allSpaces) {
      this.auditService.log({
        event: AuditEvent.SEARCH_ADMIN_CONTENT,
        resourceType: AuditResource.WORKSPACE,
        resourceId: workspace.id,
        metadata: { query: (searchDto.query ?? '').slice(0, 200) },
      });
      const results = await this.searchService.searchPage(searchDto, {
        userId: user.id,
        workspaceId: workspace.id,
        allSpaces: true,
      });
      return this.withBaseRows(results, searchDto, user.id, workspace.id);
    }

    const results =
      this.environmentService.getSearchDriver() === 'typesense'
        ? await this.searchTypesense(searchDto, {
            userId: user.id,
            workspaceId: workspace.id,
          })
        : await this.searchService.searchPage(searchDto, {
            userId: user.id,
            workspaceId: workspace.id,
          });
    return this.withBaseRows(results, searchDto, user.id, workspace.id);
  }

  // Rows of bases whose cells match join the page hits (members only).
  private async withBaseRows(
    results: unknown,
    searchDto: SearchDTO,
    userId: string,
    workspaceId: string,
  ) {
    if (!searchDto.query?.trim() || searchDto.titleOnly) {
      return results;
    }
    // The page search answers {items: [...]} (or a bare array on older paths).
    const asList = Array.isArray(results)
      ? results
      : Array.isArray((results as any)?.items)
        ? (results as any).items
        : null;
    if (!asList) return results;
    try {
      const rowSearch = this.moduleRef.get(BaseRowSearchService, { strict: false });
      const hits = await rowSearch.search(searchDto.query, userId, workspaceId, searchDto.spaceId);
      if (hits.length === 0) return results;
      const merged = [...asList, ...hits];
      return Array.isArray(results) ? merged : { ...(results as any), items: merged };
    } catch {
      return results;
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('suggest')
  @OAuthScope('read')
  async searchSuggestions(
    @Body() dto: SearchSuggestionDTO,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.searchService.searchSuggestions(dto, user.id, workspace.id);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('share-search')
  async searchShare(
    @Body() searchDto: SearchShareDTO,
    @AuthWorkspace() workspace: Workspace,
  ) {
    delete searchDto.spaceId;
    if (!searchDto.shareId) {
      throw new BadRequestException('shareId is required');
    }

    const share = await this.shareRepo.findById(searchDto.shareId);
    if (
      !share ||
      !(await this.shareService.isSharingAllowed(workspace.id, share.spaceId))
    ) {
      throw new NotFoundException('Share not found');
    }

    if (this.environmentService.getSearchDriver() === 'typesense') {
      return this.searchTypesense(searchDto, {
        workspaceId: workspace.id,
      });
    }

    return this.searchService.searchPage(searchDto, {
      workspaceId: workspace.id,
    });
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('public-space-search')
  async searchPublicSpace(
    @Body() searchDto: SearchPublicSpaceDTO,
    @AuthWorkspace() workspace: Workspace,
  ) {
    delete searchDto.spaceId;
    delete searchDto.shareId;
    // Member-facing filters stay internal: creator identities and label
    // taxonomy must not become a grouping oracle on the anonymous surface.
    delete searchDto.creatorId;
    delete searchDto.labelIds;

    const { space } = await this.publicSpaceService.getPublicSpace(
      searchDto.spaceSlug,
      workspace,
    );
    const pages = await this.pageRepo.getSpacePagesExcludingRestricted(
      space.id,
    );
    const publicPageIds = pages.map((page) => page.id);

    if (this.environmentService.getSearchDriver() === 'typesense') {
      return this.searchTypesense(searchDto, {
        workspaceId: workspace.id,
        publicPageIds,
      });
    }

    return this.searchService.searchPage(searchDto, {
      workspaceId: workspace.id,
      publicPageIds,
    });
  }

  async searchTypesense(
    searchParams: SearchDTO,
    opts: {
      userId?: string;
      workspaceId: string;
      publicPageIds?: string[];
    },
  ) {
    const { userId, workspaceId, publicPageIds } = opts;
    // The fork's Typesense search; it falls back to Postgres by itself.
    const pageSearch = this.moduleRef.get(PageSearchService, { strict: false });
    return pageSearch.searchPage(searchParams, {
      userId: userId,
      workspaceId,
      publicPageIds,
    });
  }
}
