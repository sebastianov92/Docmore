import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../casl/interfaces/workspace-ability.type';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto, WebhookIdDto } from './webhook.dto';
import { WEBHOOK_EVENTS } from './webhook.constants';

@UseGuards(JwtAuthGuard)
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
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
    return { items: await this.webhooks.list(workspace.id), events: WEBHOOK_EVENTS };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@Body() dto: CreateWebhookDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.webhooks.create(workspace.id, user.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() dto: UpdateWebhookDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.webhooks.update(workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(@Body() dto: WebhookIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    await this.webhooks.delete(workspace.id, dto.webhookId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('deliveries')
  async deliveries(@Body() dto: WebhookIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return { items: await this.webhooks.deliveries(workspace.id, dto.webhookId) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('test')
  async test(@Body() dto: WebhookIdDto, @AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.webhooks.test(workspace.id, dto.webhookId);
  }
}
