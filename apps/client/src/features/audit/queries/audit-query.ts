import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  getAuditLogs,
  getAuditRetention,
  updateAuditRetention,
} from "@/features/audit/services/audit-service";
import { IAuditLogParams } from "@/features/audit/types/audit.types";
import { getApiErrorMessage } from "@/lib/api-error";

export const AUDIT_LOGS_KEY = "audit-logs";
export const AUDIT_RETENTION_KEY = ["audit-retention"];

export function useAuditLogsQuery(params: IAuditLogParams) {
  return useQuery({
    queryKey: [AUDIT_LOGS_KEY, params],
    queryFn: () => getAuditLogs(params),
    placeholderData: keepPreviousData,
  });
}

export function useAuditRetentionQuery() {
  return useQuery({
    queryKey: AUDIT_RETENTION_KEY,
    queryFn: getAuditRetention,
  });
}

export function useUpdateAuditRetentionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: updateAuditRetention,
    onSuccess: (data) => {
      queryClient.setQueryData(AUDIT_RETENTION_KEY, data);
      notifications.show({ message: t("Audit retention updated") });
    },
    onError: (err) => {
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to update audit retention")),
        color: "red",
      });
    },
  });
}
