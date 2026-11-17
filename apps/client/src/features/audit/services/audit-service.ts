import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import { IAuditLog, IAuditLogParams } from "@/features/audit/types/audit.types";

export async function getAuditLogs(
  params: IAuditLogParams = {},
): Promise<IPagination<IAuditLog>> {
  const req = await api.post<IPagination<IAuditLog>>("/audit", params);
  return req.data;
}

export async function getAuditRetention(): Promise<{ retentionDays: number }> {
  const req = await api.post<{ retentionDays: number }>("/audit/retention", {});
  return req.data;
}

export async function updateAuditRetention(data: {
  auditRetentionDays: number;
}): Promise<{ retentionDays: number }> {
  const req = await api.post<{ retentionDays: number }>(
    "/audit/retention/update",
    data,
  );
  return req.data;
}
