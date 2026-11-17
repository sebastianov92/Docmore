import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import {
  IAddPagePermission,
  IPagePermissionMember,
  IPageRestrictionInfo,
  IRemovePagePermission,
  IUpdatePagePermission,
} from "@/features/page-permission/types/page-permission.types.ts";

export async function getPageRestrictionInfo(pageId: string): Promise<IPageRestrictionInfo> {
  const req = await api.post<IPageRestrictionInfo>("/pages/permission-info", { pageId });
  return req.data;
}

export async function getPagePermissions(
  pageId: string,
  cursor?: string,
): Promise<IPagination<IPagePermissionMember>> {
  const req = await api.post<IPagination<IPagePermissionMember>>("/pages/permissions", {
    pageId,
    ...(cursor ? { cursor } : {}),
  });
  return req.data;
}

export async function restrictPage(pageId: string): Promise<void> {
  await api.post("/pages/restrict", { pageId });
}

export async function unrestrictPage(pageId: string): Promise<void> {
  await api.post("/pages/remove-restriction", { pageId });
}

export async function addPagePermission(data: IAddPagePermission): Promise<void> {
  await api.post("/pages/add-permission", data);
}

export async function updatePagePermission(data: IUpdatePagePermission): Promise<void> {
  await api.post("/pages/update-permission", data);
}

export async function removePagePermission(data: IRemovePagePermission): Promise<void> {
  await api.post("/pages/remove-permission", data);
}
