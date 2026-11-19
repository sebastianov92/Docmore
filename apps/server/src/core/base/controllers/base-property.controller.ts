import {
  ForbiddenException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BasePropertyService } from '../services/base-property.service';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { CreatePropertyDto } from '../dto/create-property.dto';
import {
  UpdatePropertyDto,
  DeletePropertyDto,
  ReorderPropertyDto,
} from '../dto/update-property.dto';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { assertBaseUnlocked } from '../services/base-lock';
import { BaseVisibilityService } from '../services/base-visibility.service';

@UseGuards(JwtAuthGuard)
@Controller('bases/properties')
export class BasePropertyController {
  constructor(
    private readonly visibility: BaseVisibilityService,
    private readonly basePropertyService: BasePropertyService,
    private readonly baseRepo: BaseRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  // Only space admins decide who sees a column.
  private async assertCanRestrict(user: User, spaceId: string): Promise<void> {
    if ((await this.visibility.levelFor(user, spaceId)) !== 'admins') {
      throw new ForbiddenException('Only space admins can restrict a property');
    }
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('create')
  async create(
    @Body() dto: CreatePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);
    assertBaseUnlocked(base);

    if (dto.restrictedTo !== undefined) await this.assertCanRestrict(user, base.spaceId);

    return this.basePropertyService.create(workspace.id, dto, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('update')
  async update(
    @Body() dto: UpdatePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);
    assertBaseUnlocked(base);

    if (dto.restrictedTo !== undefined) await this.assertCanRestrict(user, base.spaceId);

    return this.basePropertyService.update(dto, workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('delete')
  async delete(
    @Body() dto: DeletePropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);
    assertBaseUnlocked(base);

    await this.basePropertyService.delete(dto, workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('reorder')
  async reorder(
    @Body() dto: ReorderPropertyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) {
      throw new NotFoundException('Base not found');
    }

    await this.pageAccessService.validateCanEdit(base, user);
    assertBaseUnlocked(base);

    await this.basePropertyService.reorder(dto, workspace.id, user.id);
  }
}
