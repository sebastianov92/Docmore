import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import {
  IPageVerificationInfo,
  ISetupVerification,
  IUpdateVerification,
  IVerificationChanges,
  IVerificationListItem,
  IVerificationListParams,
} from "./types";

export async function getVerificationInfo(pageId: string): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/verification-info", { pageId });
  return req.data;
}

export async function getVerificationChanges(pageId: string): Promise<IVerificationChanges> {
  const req = await api.post<IVerificationChanges>("/pages/verification-changes", { pageId });
  return req.data;
}

export async function setupVerification(data: ISetupVerification): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/create-verification", data);
  return req.data;
}

export async function updateVerification(data: IUpdateVerification): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/update-verification", data);
  return req.data;
}

export async function removeVerification(pageId: string): Promise<void> {
  await api.post("/pages/delete-verification", { pageId });
}

export async function verifyPage(pageId: string): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/verify", { pageId });
  return req.data;
}

export async function submitForApproval(pageId: string): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/submit-for-approval", { pageId });
  return req.data;
}

export async function rejectApproval(data: {
  pageId: string;
  comment?: string;
}): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/reject-approval", data);
  return req.data;
}

export async function markObsolete(pageId: string): Promise<IPageVerificationInfo> {
  const req = await api.post<IPageVerificationInfo>("/pages/mark-obsolete", { pageId });
  return req.data;
}

export async function getVerificationList(
  params: IVerificationListParams = {},
): Promise<IPagination<IVerificationListItem>> {
  const req = await api.post<IPagination<IVerificationListItem>>("/pages/verifications", params);
  return req.data;
}
