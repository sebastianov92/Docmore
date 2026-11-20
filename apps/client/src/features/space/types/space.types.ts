import { SpaceRole } from "@/lib/types.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";
import { ExportFormat } from "@/features/page/types/page.types.ts";

export interface ISpaceSharingSettings {
  disabled?: boolean;
}

export interface ISpaceExportSettings {
  disabled?: boolean;
}

export interface ISpaceCommentsSettings {
  allowViewerComments?: boolean;
}

export interface ISpaceSettings {
  sharing?: ISpaceSharingSettings;
  export?: ISpaceExportSettings;
  comments?: ISpaceCommentsSettings;
}

export type SpaceListStatus = "active" | "archived" | "all";

// open: anyone joins · closed: listed, join by request · private: hidden
export type SpaceVisibility = "open" | "closed" | "private";

export interface IBrowseSpace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  visibility: SpaceVisibility;
  memberCount: number;
  requested: boolean;
}

export interface ISpaceJoinRequest {
  id: string;
  note: string | null;
  createdAt: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export type ISpaceHomePage = {
  id: string;
  slugId: string;
  title: string;
  icon: string | null;
};

export interface ISpace {
  id: string;
  name: string;
  description: string;
  logo?: string;
  slug: string;
  visibility?: SpaceVisibility;
  isPersonal?: boolean;
  hostname: string;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date | null;
  archivedById?: string | null;
  archivedBy?: { id: string; name: string; avatarUrl: string } | null;
  memberCount?: number;
  isPublished?: boolean;
  spaceId?: string;
  membership?: IMembership;
  settings?: ISpaceSettings;
  homePageId?: string | null;
  // hostname serving this space's public site
  publicHostname?: string | null;
  homePage?: ISpaceHomePage | null;
  // for updates
  disablePublicSharing?: boolean;
  disableExport?: boolean;
  allowViewerComments?: boolean;
}

interface IMembership {
  userId: string;
  role: SpaceRole;
  permissions?: Permissions;
}

interface Permission {
  action: SpaceCaslAction;
  subject: SpaceCaslSubject;
}

type Permissions = Permission[];

export interface IAddSpaceMember {
  spaceId: string;
  userIds?: string[];
  groupIds?: string[];
}

export interface IRemoveSpaceMember {
  spaceId: string;
  userId?: string;
  groupId?: string;
}

export interface IChangeSpaceMemberRole {
  spaceId: string;
  userId?: string;
  groupId?: string;
}

// space member
export interface SpaceUserInfo {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  type: "user";
}

export interface SpaceGroupInfo {
  id: string;
  name: string;
  isDefault: boolean;
  memberCount: number;
  type: "group";
}

export type ISpaceMember = { role: string } & (SpaceUserInfo | SpaceGroupInfo);

export interface IExportSpaceParams {
  spaceId: string;
  format: ExportFormat;
  includeAttachments?: boolean;
}
