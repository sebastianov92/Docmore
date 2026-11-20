import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { UserRole } from '../../../common/helpers/types/permission';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  IWorkspaceAbility,
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../interfaces/workspace-ability.type';

@Injectable()
export default class WorkspaceAbilityFactory {
  createForUser(user: User, workspace: Workspace) {
    const userRole = user.role;

    switch (userRole) {
      case UserRole.OWNER:
        return buildWorkspaceOwnerAbility();
      case UserRole.ADMIN:
        return buildWorkspaceAdminAbility(((user as any).adminScopes as string[] | null) ?? null);
      case UserRole.MEMBER:
        return buildWorkspaceMemberAbility();
      case UserRole.GUEST:
        return buildWorkspaceGuestAbility();
      default:
        throw new NotFoundException('Workspace permissions not found');
    }
  }
}

function buildWorkspaceOwnerAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit);

  return build();
}

// An admin manages everything unless the owner narrowed it to some scopes;
// what is left out stays readable, as for a member.
function buildWorkspaceAdminAbility(scopes: string[] | null) {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  const has = (scope: string) => scopes === null || scopes.includes(scope);

  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Space);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);
  if (has('settings')) can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  if (has('members')) {
    can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
    can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Group);
  }
  if (has('spaces')) can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space);
  if (has('api')) can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API);
  if (scopes !== null && scopes.includes('audit')) can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit);

  return build();
}

// Guests reach only what is shared with them: no workspace directory at all.
function buildWorkspaceGuestAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  return build();
}

function buildWorkspaceMemberAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Space);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);

  return build();
}
