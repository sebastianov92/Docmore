import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../casl/interfaces/workspace-ability.type';
import { NotificationWebhookService } from './services/notification-webhook.service';

export class AddNotificationWebhookDto {
  @IsIn(['slack', 'teams'])
  type: 'slack' | 'teams';

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsString()
  @IsNotEmpty()
  url: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

export class NotificationWebhookIdDto {
  @IsString()
  @IsNotEmpty()
  id: string;
}

@UseGuards(JwtAuthGuard)
@Controller('notifications/webhooks')
export class NotificationWebhookController {
  constructor(
    private readonly webhooks: NotificationWebhookService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) throw new ForbiddenException();
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return { items: await this.webhooks.list(workspace.id) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('add')
  async add(@Body() dto: AddNotificationWebhookDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.webhooks.add(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove')
  async remove(@Body() dto: NotificationWebhookIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    await this.webhooks.remove(workspace.id, dto.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(@Body() dto: NotificationWebhookIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.webhooks.test(workspace.id, dto.id);
  }
}
