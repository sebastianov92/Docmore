import api from "@/lib/api-client";
import { IUser } from "@/features/user/types/user.types";
import {
  ICreateInvite,
  IInvitation,
  IWorkspace,
  IAcceptInvite,
  IPublicWorkspace,
  IInvitationLink,
  IVersion,
} from "../types/workspace.types";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { ISetupWorkspace } from "@/features/auth/types/auth.types.ts";
import {
  IInviteRequest,
  IWorkspaceDomains,
} from "@/features/workspace/types/workspace.types.ts";

export async function getWorkspace(): Promise<IWorkspace> {
  const req = await api.post<IWorkspace>("/workspace/info");
  return req.data;
}

export async function getWorkspacePublicData(): Promise<IPublicWorkspace> {
  const req = await api.post<IPublicWorkspace>("/workspace/public");
  return req.data;
}

export async function getCheckHostname(
  hostname: string,
): Promise<{ hostname: string }> {
  const req = await api.post("/workspace/check-hostname", { hostname });
  return req.data;
}

export async function getWorkspaceMembers(
  params?: QueryParams,
): Promise<IPagination<IUser>> {
  const req = await api.post("/workspace/members", params);
  return req.data;
}

export async function deleteWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/delete", data);
}

export async function deactivateWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/deactivate", data);
}

export async function activateWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/activate", data);
}

export async function updateWorkspace(data: Partial<IWorkspace>) {
  const req = await api.post<IWorkspace>("/workspace/update", data);
  return req.data;
}

export async function changeMemberRole(data: {
  userId: string;
  role: string;
  adminScopes?: string[] | null;
}): Promise<void> {
  await api.post("/workspace/members/change-role", data);
}

export async function getPendingInvitations(
  params?: QueryParams,
): Promise<IPagination<IInvitation>> {
  const req = await api.post("/workspace/invites", params);
  return req.data;
}

export async function createInvitation(data: ICreateInvite) {
  const req = await api.post("/workspace/invites/create", data);
  return req.data;
}

export async function acceptInvitation(
  data: IAcceptInvite,
): Promise<{ requiresLogin?: boolean }> {
  const req = await api.post("/workspace/invites/accept", data);
  return req.data;
}

export async function getInviteLink(data: {
  invitationId: string;
}): Promise<IInvitationLink> {
  const req = await api.post("/workspace/invites/link", data);
  return req.data;
}

export async function resendInvitation(data: {
  invitationId: string;
}): Promise<void> {
  await api.post("/workspace/invites/resend", data);
}

export async function revokeInvitation(data: {
  invitationId: string;
}): Promise<void> {
  await api.post("/workspace/invites/revoke", data);
}

export async function getInvitationById(data: {
  invitationId: string;
}): Promise<IInvitation> {
  const req = await api.post("/workspace/invites/info", data);
  return req.data;
}

export async function createWorkspace(
  data: ISetupWorkspace,
): Promise<{ workspace: IWorkspace; exchangeToken?: string; requiresEmailVerification?: boolean; emailSignature?: string }> {
  const req = await api.post("/workspace/create", data);
  return req.data;
}

export async function getAppVersion(): Promise<IVersion> {
  const req = await api.post("/version");
  return req.data;
}

// Invite requests: members ask, admins approve (which sends the invite).
export async function createInviteRequest(data: { emails: string[]; note?: string }) {
  const req = await api.post<{ requested: string[]; skipped: string[] }>("/workspace/invite-requests/create", data);
  return req.data;
}

export async function getInviteRequests(): Promise<{ items: IInviteRequest[] }> {
  const req = await api.post("/workspace/invite-requests");
  return req.data;
}

export async function getMyInviteRequests(): Promise<{ items: IInviteRequest[] }> {
  const req = await api.post("/workspace/invite-requests/mine");
  return req.data;
}

export async function reviewInviteRequest(requestId: string, approve: boolean): Promise<void> {
  await api.post(approve ? "/workspace/invite-requests/approve" : "/workspace/invite-requests/reject", { requestId });
}

// Verified domains: DNS TXT proof, then optional self sign-up.
export async function getWorkspaceDomains(): Promise<IWorkspaceDomains> {
  const req = await api.post("/workspace/domains");
  return req.data;
}
export async function addWorkspaceDomain(domain: string): Promise<IWorkspaceDomains> {
  const req = await api.post("/workspace/domains/add", { domain });
  return req.data;
}
export async function verifyWorkspaceDomain(domain: string): Promise<IWorkspaceDomains> {
  const req = await api.post("/workspace/domains/verify", { domain });
  return req.data;
}
export async function removeWorkspaceDomain(domain: string): Promise<IWorkspaceDomains> {
  const req = await api.post("/workspace/domains/remove", { domain });
  return req.data;
}
export async function setWorkspaceDomainAutoJoin(autoJoin: boolean): Promise<IWorkspaceDomains> {
  const req = await api.post("/workspace/domains/auto-join", { autoJoin });
  return req.data;
}
