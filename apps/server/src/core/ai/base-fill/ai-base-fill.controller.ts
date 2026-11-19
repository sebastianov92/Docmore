import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsUUID, Matches } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BASE_PROPERTY_ID_RE } from '../../base/base-ids';
import { AiBaseFillService } from './ai-base-fill.service';

export class AiFillDto {
  @IsUUID()
  pageId: string;

  @Matches(BASE_PROPERTY_ID_RE)
  propertyId: string;

  // these rows, or every row with an empty cell
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  rowIds?: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('ai/bases')
export class AiBaseFillController {
  constructor(
    private readonly fill: AiBaseFillService,
    private readonly baseRepo: BaseRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('fill')
  async fillProperty(@Body() dto: AiFillDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const base = await this.baseRepo.findById(dto.pageId);
    if (!base) throw new NotFoundException('Base not found');
    await this.pageAccessService.validateCanEdit(base, user);
    await this.fill.enqueue({ pageId: dto.pageId, propertyId: dto.propertyId, workspaceId: workspace.id, userId: user.id, rowIds: dto.rowIds, onlyEmpty: !dto.rowIds });
    return { queued: true };
  }
}
