import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { getOAuthGrants, revokeOAuthGrant } from "./services";

export const OAUTH_GRANTS_KEY = ["oauth-grants"];

export function useOAuthGrantsQuery(enabled = true) {
  return useQuery({ queryKey: OAUTH_GRANTS_KEY, queryFn: getOAuthGrants, enabled, staleTime: 0 });
}

export function useRevokeOAuthGrantMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: revokeOAuthGrant,
    onSuccess: () => {
      notifications.show({ message: t("Access revoked") });
      queryClient.invalidateQueries({ queryKey: OAUTH_GRANTS_KEY });
    },
    onError: (err) => notifications.show({ message: getApiErrorMessage(err, t("Could not revoke access")), color: "red" }),
  });
}
