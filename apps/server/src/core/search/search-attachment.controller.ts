import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
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
import { SearchDTO } from './dto/search.dto';
import { SearchAttachmentService } from './search-attachment.service';
import { AttachmentIndexService } from '../attachment/services/attachment-index.service';

@UseGuards(JwtAuthGuard)
@Controller('search-attachments')
export class SearchAttachmentController {
  constructor(
    private readonly searchAttachmentService: SearchAttachmentService,
    private readonly attachmentIndexService: AttachmentIndexService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  @OAuthScope('read')
  async search(
    @Body() dto: SearchDTO,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    delete dto.shareId;

    if (dto.spaceId) {
      const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    return this.searchAttachmentService.search(dto, {
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  // Admin escape hatch: queues every indexable file in the workspace again,
  // text already extracted included. Useful after an extractor fix.
  @HttpCode(HttpStatus.OK)
  @Post('reindex')
  @RequireSessionAuth()
  async reindex(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
    await this.attachmentIndexService.queueWorkspaceBackfill(workspace.id, {
      force: true,
    });
    return { queued: true };
  }
}
