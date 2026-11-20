import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { ApiKeyScope } from '../../common/decorators/api-key-scope.decorator';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../casl/interfaces/space-ability.type';
import { ClipperService } from './clipper.service';
import { ClipDto } from './clipper.dto';

// Web clipper: the browser extension and the bookmarklet post here.
@UseGuards(JwtAuthGuard)
@Controller('clipper')
export class ClipperController {
  constructor(
    private readonly clipper: ClipperService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @ApiKeyScope('write')
  @OAuthScope('write')
  @Post('clip')
  async clip(@Body() dto: ClipDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) throw new ForbiddenException();
    return this.clipper.clip(dto, user, workspace.id);
  }
}
