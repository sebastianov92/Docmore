export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin', // can have owner permissions but cannot delete workspace
  MEMBER = 'member',
  GUEST = 'guest', // sees only the spaces and pages shared with them
}

// What an admin may manage when the owner narrows it; null means everything.
export const ADMIN_SCOPES = ['settings', 'members', 'spaces', 'api', 'audit', 'ai', 'integrations'] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

export enum InviteUserRole {
  ADMIN = 'admin', // can have owner permissions but cannot delete workspace
  MEMBER = 'member',
  GUEST = 'guest',
}

export enum SpaceRole {
  ADMIN = 'admin', // can manage space settings, members, and delete space
  WRITER = 'writer', // can read and write pages in space
  COMMENTER = 'commenter', // can read pages and comment on them
  READER = 'reader', // can only read pages in space
}

export enum SpaceVisibility {
  OPEN = 'open', // any workspace member can see that it exists and join.
  CLOSED = 'closed', // listed for everyone; joining needs a space admin's approval
  PRIVATE = 'private', // only added space users can see
}

export enum PageAccessLevel {
  RESTRICTED = 'restricted', // only specific users/groups can view or edit
}

export enum PagePermissionRole {
  READER = 'reader', // can only view content and descendants
  WRITER = 'writer', // can edit content, descendants, and add new users to permission
}
