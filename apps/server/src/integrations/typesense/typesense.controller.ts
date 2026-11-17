import { Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../core/casl/interfaces/workspace-ability.type';
import { EnvironmentService } from '../environment/environment.service';
import { TypesenseService } from './typesense.service';
import { PageIndexService } from './page-index.service';

// Admin view of the search index: which driver, whether Typesense answers,
// how many pages it holds, and a way to rebuild it.
@UseGuards(JwtAuthGuard)
@Controller('search-index')
export class TypesenseController {
  constructor(
    private readonly environment: EnvironmentService,
    private readonly typesense: TypesenseService,
    private readonly index: PageIndexService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('status')
  async status(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    const driver = this.environment.getSearchDriver();
    let documents: number | null = null;
    let ready = false;
    if (this.typesense.enabled) {
      ready = this.typesense.ready || (await this.typesense.ensureCollection());
      if (ready) {
        try {
          documents = await this.typesense.documentCount();
        } catch {
          documents = null;
        }
      }
    }
    return { driver, ready, documents, url: this.typesense.enabled ? this.environment.getTypesenseUrl() : null };
  }

  @HttpCode(HttpStatus.OK)
  @Post('reindex')
  async reindex(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    if (!this.typesense.enabled) {
      throw new ForbiddenException('The search driver is Postgres; nothing to rebuild');
    }
    await this.index.requestBackfill(workspace.id);
    return { queued: true };
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
  }
}
