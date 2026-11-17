import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageVerificationService } from './page-verification.service';
import {
  RejectApprovalDto,
  SetupVerificationDto,
  UpdateVerificationDto,
  VerificationListDto,
  VerificationPageIdDto,
} from './dto/page-verification.dto';

// Lives under /pages next to the page routes the client already knows.
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageVerificationController {
  constructor(private readonly service: PageVerificationService) {}

  @HttpCode(HttpStatus.OK)
  @Post('verification-info')
  @OAuthScope('read')
  info(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.getInfo(dto.pageId, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('verification-changes')
  @OAuthScope('read')
  changes(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.getChanges(dto.pageId, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('verifications')
  @OAuthScope('read')
  list(@Body() dto: VerificationListDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.list(dto, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('create-verification')
  @OAuthScope('write')
  create(@Body() dto: SetupVerificationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.setup(dto, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-verification')
  @OAuthScope('write')
  update(@Body() dto: UpdateVerificationDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.update(dto, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete-verification')
  @OAuthScope('write')
  async remove(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    await this.service.remove(dto.pageId, { user, workspace });
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('verify')
  @OAuthScope('write')
  verify(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.verify(dto.pageId, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('submit-for-approval')
  @OAuthScope('write')
  submit(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.submitForApproval(dto.pageId, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('reject-approval')
  @OAuthScope('write')
  reject(@Body() dto: RejectApprovalDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.reject(dto, { user, workspace });
  }

  @HttpCode(HttpStatus.OK)
  @Post('mark-obsolete')
  @OAuthScope('write')
  obsolete(@Body() dto: VerificationPageIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.markObsolete(dto.pageId, { user, workspace });
  }
}
