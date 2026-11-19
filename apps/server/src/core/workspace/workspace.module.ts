import { Module } from '@nestjs/common';
import { WorkspaceService } from './services/workspace.service';
import { WorkspaceController } from './controllers/workspace.controller';
import { SpaceModule } from '../space/space.module';
import { WorkspaceInvitationService } from './services/workspace-invitation.service';
import { TokenModule } from '../auth/token.module';
import { IntegrationModule } from '../integration/integration.module';
import { WorkspaceInviteRequestService } from './services/workspace-invite-request.service';
import { WorkspaceDomainService } from './services/workspace-domain.service';

@Module({
  imports: [SpaceModule, TokenModule, IntegrationModule],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceInvitationService,
    WorkspaceInviteRequestService,
    WorkspaceDomainService,
  ],
  exports: [WorkspaceService, WorkspaceDomainService],
})
export class WorkspaceModule {}
