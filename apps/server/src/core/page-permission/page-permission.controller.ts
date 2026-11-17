import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiKeyScope } from '../../common/decorators/api-key-scope.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PagePermissionService } from './page-permission.service';
import {
  AddPagePermissionDto,
  ListPagePermissionsDto,
  PageIdDto,
  RemovePagePermissionDto,
  UpdatePagePermissionDto,
} from './dto/page-permission.dto';

// Same paths the page share dialog already calls.
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PagePermissionController {
  constructor(private readonly pagePermissionService: PagePermissionService) {}

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('permission-info')
  async info(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    return this.pagePermissionService.getRestrictionInfo(user, page);
  }

  @ApiKeyScope('read')
  @HttpCode(HttpStatus.OK)
  @Post('permissions')
  async list(
    @Body() dto: ListPagePermissionsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    return this.pagePermissionService.list(user, page, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('restrict')
  async restrict(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    await this.pagePermissionService.restrict(user, page);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-restriction')
  async removeRestriction(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    await this.pagePermissionService.removeRestriction(user, page);
  }

  @HttpCode(HttpStatus.OK)
  @Post('add-permission')
  async add(
    @Body() dto: AddPagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    await this.pagePermissionService.add(user, page, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-permission')
  async update(
    @Body() dto: UpdatePagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    await this.pagePermissionService.updateRole(user, page, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-permission')
  async remove(
    @Body() dto: RemovePagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPage(dto.pageId, workspace.id);
    await this.pagePermissionService.remove(user, page, dto);
  }
}
