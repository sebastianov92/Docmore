// Event names are "<resource>.<action>" as the server emits them. Labels
// are derived from the name, so a new event shows up readable without a
// client change; the filter list below is the curated subset worth
// offering in the dropdown.

const RESOURCE_WORDS: Record<string, string> = {
  api_key: "API key",
  sso: "SSO",
  mfa: "two-factor",
  oauth_client: "OAuth client",
  oauth_grant: "OAuth grant",
  scim_token: "SCIM token",
  siem_destination: "SIEM destination",
};

const PHRASES: Record<string, string> = {
  "user.login": "Signed in",
  "user.logout": "Signed out",
  "user.mfa_enabled": "Enabled two-factor authentication",
  "user.mfa_disabled": "Disabled two-factor authentication",
  "user.mfa_backup_code_generated": "Generated two-factor backup codes",
  "user.password_reset_requested": "Requested a password reset",
  "page.trashed": "Moved page to trash",
  "page.restriction_removed": "Removed page restriction",
  "page.permission_role_changed": "Changed page permission",
  "space.member_role_changed": "Changed space member role",
  "comment.reopened": "Re-opened comment",
  "share.created": "Created public link",
  "share.deleted": "Deleted public link",
  "workspace.invite_created": "Invited someone",
  "workspace.invite_resent": "Resent an invitation",
  "workspace.invite_revoked": "Revoked an invitation",
};

export function humanizeResource(resource: string): string {
  return RESOURCE_WORDS[resource] ?? resource.replace(/_/g, " ");
}

// "space.member_added" -> "Added space member"; "page.deleted" -> "Deleted page".
export function eventLabel(event: string): string {
  if (PHRASES[event]) return PHRASES[event];
  const dot = event.indexOf(".");
  if (dot < 0) return event;
  const resource = humanizeResource(event.slice(0, dot));
  const action = event.slice(dot + 1).replace(/_/g, " ");
  const words = action.split(" ");
  const verb = words[words.length - 1];
  const object = words.slice(0, -1).join(" ");
  const text = object ? `${verb} ${resource} ${object}` : `${verb} ${resource}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface EventGroup {
  group: string;
  events: string[];
}

export const EVENT_FILTER_GROUPS: EventGroup[] = [
  {
    group: "Users",
    events: [
      "user.login",
      "user.logout",
      "user.created",
      "user.deleted",
      "user.updated",
      "user.deactivated",
      "user.activated",
      "user.role_changed",
      "user.password_changed",
      "user.password_reset",
      "user.password_reset_requested",
      "user.mfa_enabled",
      "user.mfa_disabled",
      "user.mfa_backup_code_generated",
    ],
  },
  {
    group: "Workspace",
    events: [
      "workspace.updated",
      "workspace.invite_created",
      "workspace.invite_resent",
      "workspace.invite_revoked",
      "api_key.created",
      "api_key.updated",
      "api_key.deleted",
      "sso.provider_created",
      "sso.provider_updated",
      "sso.provider_deleted",
      "template.created",
      "template.deleted",
    ],
  },
  {
    group: "Spaces and groups",
    events: [
      "space.created",
      "space.updated",
      "space.deleted",
      "space.archived",
      "space.unarchived",
      "space.member_added",
      "space.member_removed",
      "space.member_role_changed",
      "space.exported",
      "group.created",
      "group.updated",
      "group.deleted",
      "group.member_added",
      "group.member_removed",
    ],
  },
  {
    group: "Pages",
    events: [
      "page.trashed",
      "page.deleted",
      "page.restored",
      "page.imported",
      "page.exported",
      "page.restricted",
      "page.restriction_removed",
      "page.permission_added",
      "page.permission_removed",
      "page.permission_role_changed",
      "share.created",
      "share.deleted",
      "attachment.deleted",
      "comment.updated",
      "comment.resolved",
      "comment.reopened",
      "comment.deleted",
    ],
  },
];

// Resource types shown as a badge next to the event.
export function resourceTypeLabel(type: string): string {
  const word = humanizeResource(type);
  return word.charAt(0).toUpperCase() + word.slice(1);
}
