import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { ShareService } from './share.service';
import {
  CreateShareDto,
  ShareIdDto,
  ShareInfoDto,
  SharePageIdDto,
  UpdateShareDto,
} from './dto/share.dto';
import { ShareTransclusionLookupDto } from './dto/share-transclusion-lookup.dto';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { LicenseCheckService } from '../../integrations/environment/license-check.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { ApiKeyScope } from '../../common/decorators/api-key-scope.decorator';
import { UnlockShareDto } from './dto/unlock-share.dto';

@UseGuards(JwtAuthGuard)
@Controller('shares')
export class ShareController {
  constructor(
    private readonly shareService: ShareService,
    private readonly shareRepo: ShareRepo,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly licenseCheckService: LicenseCheckService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('/')
  async getShares(
    @AuthUser() user: User,
    @Body() pagination: PaginationOptions,
  ) {
    const result = await this.shareService.getShares(user.id, pagination);
    result.items = result.items.map(publicShare);
    return result;
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/page-info')
  async getSharedPageInfo(
    @Body() dto: ShareInfoDto,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-share-token') shareToken?: string,
  ) {
    if (!dto.pageId && !dto.shareId) {
      throw new BadRequestException();
    }

    const shareData = await this.shareService.getSharedPage(dto, workspace.id, {
      shareToken,
    });

    const sharingAllowed = await this.shareService.isSharingAllowed(
      workspace.id,
      shareData.share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Shared page not found');
    }

    return {
      ...shareData,
      share: publicShare(shareData.share),
      features: this.licenseCheckService.resolveFeatures(
        workspace.licenseKey,
        workspace.plan,
      ),
    };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/info')
  async getShare(
    @Body() dto: ShareIdDto,
    @Headers('x-share-token') shareToken?: string,
  ) {
    const share = await this.shareRepo.findById(dto.shareId, {
      includeSharedPage: true,
    });

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    const sharingAllowed = await this.shareService.isSharingAllowed(
      share.workspaceId,
      share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Share not found');
    }

    await this.shareService.assertShareAccess(share, shareToken);
    return publicShare(share);
  }

  // Trades the share password for the token the share's pages send back.
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/unlock')
  async unlock(
    @Body() dto: UnlockShareDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.shareService.unlockShare(
      dto.shareId,
      dto.password,
      workspace.id,
    );
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/transclusion/lookup')
  async transclusionLookup(
    @Body() dto: ShareTransclusionLookupDto,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-share-token') shareToken?: string,
  ) {
    return this.shareService.lookupTransclusionForShare(
      dto.shareId,
      dto.references,
      workspace.id,
      shareToken,
    );
  }

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('/for-page')
  async getShareForPage(
    @Body() dto: SharePageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Shared page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return publicShare(
      await this.shareService.getShareForPage(page.id, workspace.id),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() createShareDto: CreateShareDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(createShareDto.pageId);

    if (!page || workspace.id !== page.workspaceId) {
      throw new NotFoundException('Page not found');
    }

    // User must be able to edit the page to create a share
    //TODO: i dont think this is neccessary if we prevent restricted pages from getting shared
    // rather, use space level permission and workspace/space level sharing restriction
    await this.pageAccessService.validateCanEdit(page, user);

    // Prevent sharing restricted pages
    const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
      page.id,
    );
    if (isRestricted) {
      throw new BadRequestException('Cannot share a restricted page');
    }

    const sharingAllowed = await this.shareService.isSharingAllowed(
      workspace.id,
      page.spaceId,
    );
    if (!sharingAllowed) {
      throw new ForbiddenException('Public sharing is disabled');
    }

    const share = await this.shareService.createShare({
      page,
      authUserId: user.id,
      workspaceId: workspace.id,
      createShareDto,
    });

    this.auditService.log({
      event: AuditEvent.SHARE_CREATED,
      resourceType: AuditResource.SHARE,
      resourceId: share.id,
      spaceId: page.spaceId,
      metadata: {
        pageId: page.id,
        spaceId: page.spaceId,
      },
    });

    return publicShare(share);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() updateShareDto: UpdateShareDto, @AuthUser() user: User) {
    const share = await this.shareRepo.findById(updateShareDto.shareId);

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    const page = await this.pageRepo.findById(share.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    // User must be able to edit the page to update its share
    await this.pageAccessService.validateCanEdit(page, user);

    return publicShare(
      await this.shareService.updateShare(share.id, updateShareDto),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(@Body() shareIdDto: ShareIdDto, @AuthUser() user: User) {
    const share = await this.shareRepo.findById(shareIdDto.shareId);

    if (!share) {
      throw new NotFoundException('Share not found');
    }

    const page = await this.pageRepo.findById(share.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    // User must be able to edit the page to delete its share
    await this.pageAccessService.validateCanEdit(page, user);

    await this.shareRepo.deleteShare(share.id);

    this.auditService.log({
      event: AuditEvent.SHARE_DELETED,
      resourceType: AuditResource.SHARE,
      resourceId: share.id,
      spaceId: share.spaceId,
      changes: {
        before: {
          pageId: share.pageId,
          spaceId: share.spaceId,
        },
      },
    });
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('/tree')
  async getSharePageTree(
    @Body() dto: ShareIdDto,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-share-token') shareToken?: string,
  ) {
    const treeData = await this.shareService.getShareTree(
      dto.shareId,
      workspace.id,
      shareToken,
    );

    const sharingAllowed = await this.shareService.isSharingAllowed(
      workspace.id,
      treeData.share.spaceId,
    );
    if (!sharingAllowed) {
      throw new NotFoundException('Share not found');
    }

    return {
      ...treeData,
      share: publicShare(treeData.share),
      features: this.licenseCheckService.resolveFeatures(
        workspace.licenseKey,
        workspace.plan,
      ),
    };
  }
}

// What leaves the server: the hash stays, readers learn only that a
// password exists.
function publicShare<T extends object | null | undefined>(share: T) {
  if (!share) return share;
  const { passwordHash, ...rest } = share as any;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}
