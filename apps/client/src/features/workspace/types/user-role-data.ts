import { IRoleData, UserRole } from "@/lib/types.ts";

export const userRoleData: IRoleData[] = [
  {
    label: "Owner",
    value: UserRole.OWNER,
    description: "Can manage workspace",
  },
  {
    label: "Admin",
    value: UserRole.ADMIN,
    description: "Can manage workspace but cannot delete it",
  },
  {
    label: "Member",
    value: UserRole.MEMBER,
    description: "Can become members of groups and spaces in workspace",
  },
  {
    label: "Guest",
    value: UserRole.GUEST,
    description: "Sees only the spaces and pages shared with them; no directory",
  },
];

// What an admin may manage when the owner narrows it.
export const adminScopeData: { value: string; label: string }[] = [
  { value: "settings", label: "Workspace settings" },
  { value: "members", label: "Members and groups" },
  { value: "spaces", label: "Spaces" },
  { value: "api", label: "API keys" },
  { value: "audit", label: "Audit logs" },
  { value: "ai", label: "AI settings" },
  { value: "integrations", label: "Integrations" },
];

export function getUserRoleLabel(value: string) {
  const role = userRoleData.find((item) => item.value === value);
  return role ? role.label : undefined;
}
