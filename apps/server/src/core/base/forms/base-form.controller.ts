import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { ApiKeyScope } from '../../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { BaseRepo } from '@docmost/db/repos/base/base.repo';
import { PageAccessService } from '../../page/page-access/page-access.service';
import { BaseFormService } from './base-form.service';
import { CreateFormDto, FormIdDto, FormTokenDto, ListFormsDto, SubmitFormDto, UpdateFormDto } from '../dto/form.dto';

@UseGuards(JwtAuthGuard)
@Controller('bases/forms')
export class BaseFormController {
  constructor(
    private readonly forms: BaseFormService,
    private readonly baseRepo: BaseRepo,
    private readonly pageAccessService: PageAccessService,
  ) {}

  private async base(pageId: string, user: User, mode: 'view' | 'edit') {
    const base = await this.baseRepo.findById(pageId);
    if (!base) throw new NotFoundException('Base not found');
    if (mode === 'edit') await this.pageAccessService.validateCanEdit(base, user);
    else await this.pageAccessService.validateCanView(base, user);
    return base;
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('read')
  @OAuthScope('read')
  @Post()
  async list(@Body() dto: ListFormsDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'view');
    return { items: await this.forms.list(dto.pageId, workspace.id) };
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('create')
  async create(@Body() dto: CreateFormDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    return this.forms.create(dto, workspace.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('update')
  async update(@Body() dto: UpdateFormDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    return this.forms.update(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('delete')
  async delete(@Body() dto: FormIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.base(dto.pageId, user, 'edit');
    await this.forms.delete(dto.formId, dto.pageId, workspace.id);
  }
}

// The form itself: anyone with the link.
@Controller('forms/public')
export class BaseFormPublicController {
  constructor(private readonly forms: BaseFormService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@Body() dto: FormTokenDto, @AuthWorkspace() workspace: Workspace) {
    return this.forms.publicInfo(dto.token, workspace.id);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('submit')
  async submit(@Body() dto: SubmitFormDto, @AuthWorkspace() workspace: Workspace, @Req() req: FastifyRequest) {
    const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    return this.forms.submit(dto.token, dto.cells, dto.website, forwarded || req.ip, workspace.id);
  }
}
