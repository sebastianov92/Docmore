import type { JSONContent } from "@tiptap/react";

export type VerificationType = "expiring" | "qms";
export type ExpirationMode = "period" | "fixed" | "indefinite";
export type PeriodUnit = "day" | "week" | "month" | "year";

export type VerificationStatus =
  | "verified"
  | "expiring"
  | "expired"
  | "invalidated"
  | "draft"
  | "in_approval"
  | "approved"
  | "obsolete"
  | "none";

export interface IUserRef {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface IVerifier extends IUserRef {
  email?: string;
}

export interface IVerificationPermissions {
  canVerify: boolean;
  canManage: boolean;
  canSubmitForApproval: boolean;
  canMarkObsolete: boolean;
}

export interface IPageVerificationInfo {
  id?: string;
  pageId?: string;
  type?: VerificationType;
  mode?: ExpirationMode | null;
  periodAmount?: number | null;
  periodUnit?: PeriodUnit | null;
  status: VerificationStatus;
  verifiedAt?: string | null;
  verifiedBy?: IUserRef | null;
  expiresAt?: string | null;
  requestedAt?: string | null;
  requestedBy?: IUserRef | null;
  rejectedAt?: string | null;
  rejectedBy?: IUserRef | null;
  rejectionComment?: string | null;
  invalidatedAt?: string | null;
  invalidatedBy?: IUserRef | null;
  verifiedHistoryId?: string | null;
  rejectedHistoryId?: string | null;
  verifiers?: IVerifier[];
  permissions?: IVerificationPermissions;
}

export interface IBaseline {
  historyId: string;
  title: string | null;
  content: JSONContent;
  hasChanges: boolean;
}

export interface IVerificationChanges {
  type: VerificationType;
  verified: (IBaseline & { verifiedAt: string | null; verifiedBy: IUserRef | null }) | null;
  rejected: (IBaseline & { rejectedAt: string | null; rejectedBy: IUserRef | null }) | null;
  current: {
    title: string | null;
    content: JSONContent;
    updatedAt: string;
    lastUpdatedBy: IUserRef | null;
  };
}

export type BaselineKind = "verified" | "rejected";

export interface ISetupVerification {
  pageId: string;
  type: VerificationType;
  mode?: ExpirationMode;
  periodAmount?: number;
  periodUnit?: PeriodUnit;
  fixedExpiresAt?: string;
  verifierIds: string[];
}

export interface IUpdateVerification {
  pageId: string;
  mode?: ExpirationMode;
  periodAmount?: number;
  periodUnit?: PeriodUnit;
  fixedExpiresAt?: string;
  verifierIds?: string[];
}

export interface IVerificationListItem {
  id: string;
  pageId: string;
  spaceId: string;
  type: VerificationType;
  status: VerificationStatus;
  mode: ExpirationMode | null;
  periodAmount: number | null;
  periodUnit: PeriodUnit | null;
  verifiedAt: string | null;
  verifiedBy: IUserRef | null;
  expiresAt: string | null;
  invalidatedAt: string | null;
  createdAt: string;
  pageTitle: string | null;
  pageSlugId: string;
  pageIcon: string | null;
  spaceName: string;
  spaceSlug: string;
  verifiers: IUserRef[];
}

export interface IVerificationListParams {
  spaceIds?: string[];
  verifierId?: string;
  type?: VerificationType;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ReviewChangesRequest {
  pageId: string;
  source: "modal" | "link";
}
