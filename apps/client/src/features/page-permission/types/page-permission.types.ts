export type PagePermissionRole = "reader" | "writer";

export interface IPageRestrictionInfo {
  restrictionId?: string;
  hasDirectRestriction: boolean;
  hasInheritedRestriction: boolean;
  inheritedFrom?: { id: string; slugId: string; title: string | null };
  userAccess: { canView: boolean; canEdit: boolean; canManage: boolean };
}

interface IPagePermissionBase {
  id: string;
  name: string;
  role: PagePermissionRole;
  createdAt: string;
}

export type IPagePermissionUser = IPagePermissionBase & {
  type: "user";
  email: string;
  avatarUrl: string | null;
};

export type IPagePermissionGroup = IPagePermissionBase & {
  type: "group";
  memberCount: number;
  isDefault: boolean;
};

export type IPagePermissionMember = IPagePermissionUser | IPagePermissionGroup;

export interface IAddPagePermission {
  pageId: string;
  role: PagePermissionRole;
  userIds?: string[];
  groupIds?: string[];
}

export interface IUpdatePagePermission {
  pageId: string;
  role: PagePermissionRole;
  userId?: string;
  groupId?: string;
}

export interface IRemovePagePermission {
  pageId: string;
  userIds?: string[];
  groupIds?: string[];
}
