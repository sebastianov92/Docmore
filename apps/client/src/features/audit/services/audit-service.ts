import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import { IAuditLog, IAuditLogParams } from "@/features/audit/types/audit.types";
import { saveAs } from "file-saver";

export async function getAuditLogs(
  params: IAuditLogParams = {},
): Promise<IPagination<IAuditLog>> {
  const req = await api.post<IPagination<IAuditLog>>("/audit", params);
  return req.data;
}

// Downloads the filtered log as CSV (owners only).
export async function exportAuditCsv(params: IAuditLogParams = {}): Promise<void> {
  const { cursor: _cursor, limit: _limit, ...filters } = params;
  const req = await api.post("/audit/export", filters, { responseType: "blob" });
  const header = (req?.headers?.["content-disposition"] as string) ?? "";
  const match = header.match(/filename="?([^";]+)"?/i);
  saveAs(req.data, match?.[1] ?? "audit.csv");
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
