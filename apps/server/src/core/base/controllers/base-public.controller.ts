import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { ShareService } from '../../share/share.service';
import { PublicSpaceService } from '../../public-space/public-space.service';
import { BaseService } from '../services/base.service';
import { BaseRowService } from '../services/base-row.service';
import { PublicBaseInfoDto, PublicBaseRowsDto } from '../dto/public-base.dto';

// Read-only access to a base from a shared page or a published space,
// for readers without an account. The same checks the shared page itself
// goes through decide whether the base is reachable.
@Controller('bases/public')
export class BasePublicController {
  constructor(
    private readonly baseRepo: BaseRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly shareService: ShareService,
    private readonly publicSpaceService: PublicSpaceService,
    private readonly baseService: BaseService,
    private readonly baseRowService: BaseRowService,
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: PublicBaseInfoDto,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-share-token') shareToken?: string,
  ) {
    await this.assertPublic(dto.pageId, dto.shareId, workspace, shareToken);
    const info = await this.baseService.getBaseInfo(dto.pageId);
    return { ...info, permissions: { canEdit: false, hasRestriction: false } };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('rows')
  async rows(
    @Body() dto: PublicBaseRowsDto,
    @Body() pagination: PaginationOptions,
    @AuthWorkspace() workspace: Workspace,
    @Headers('x-share-token') shareToken?: string,
  ) {
    await this.assertPublic(dto.pageId, dto.shareId, workspace, shareToken);
    const { shareId: _shareId, ...listDto } = dto;
    return this.baseRowService.list(listDto, pagination, workspace.id);
  }

  private async assertPublic(
    pageId: string,
    shareId: string | undefined,
    workspace: Workspace,
    shareToken?: string,
  ) {
    const base = await this.baseRepo.findById(pageId);
    if (!base || base.workspaceId !== workspace.id || base.deletedAt) {
      throw new NotFoundException('Base not found');
    }
    if (shareId) {
      const shared = await this.shareService.getSharedPage(
        { pageId, shareId } as any,
        workspace.id,
        { includeContent: false, shareToken },
      );
      const allowed = await this.shareService.isSharingAllowed(workspace.id, shared.share.spaceId);
      if (!allowed) throw new NotFoundException('Base not found');
      return;
    }
    const space = await this.spaceRepo.findById(base.spaceId, workspace.id);
    if (!space) throw new NotFoundException('Base not found');
    // Throws when the space is not published or the page is restricted.
    await this.publicSpaceService.getPublicPage(space.slug, base.id, workspace, {
      includeContent: false,
    });
  }
}
