import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { IPagination, QueryParams } from "@/lib/types.ts";
import {
  createApiKey,
  getApiKeys,
  renameApiKey,
  revokeApiKey,
} from "@/features/api-key/services/api-key-service.ts";
import {
  IApiKey,
  ICreateApiKey,
  IRenameApiKey,
} from "@/features/api-key/types/api-key.types.ts";

export const API_KEY_LIST_KEY = "api-keys";

export function useApiKeysQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<IApiKey>, Error> {
  return useQuery({
    queryKey: [API_KEY_LIST_KEY, params],
    queryFn: () => getApiKeys(params),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateApiKeys() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === API_KEY_LIST_KEY,
    });
}

function errorMessage(error: unknown, fallback: string): string {
  return (error as any)?.response?.data?.message || fallback;
}

export function useCreateApiKeyMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateApiKeys();

  return useMutation<IApiKey, Error, ICreateApiKey>({
    mutationFn: createApiKey,
    onSuccess: () => invalidate(),
    onError: (error) => {
      notifications.show({
        message: errorMessage(error, t("Could not create the API key")),
        color: "red",
      });
    },
  });
}

export function useRenameApiKeyMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateApiKeys();

  return useMutation<IApiKey, Error, IRenameApiKey>({
    mutationFn: renameApiKey,
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      invalidate();
    },
    onError: (error) => {
      notifications.show({
        message: errorMessage(error, t("Could not rename the API key")),
        color: "red",
      });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateApiKeys();

  return useMutation<void, Error, string>({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      notifications.show({ message: t("Revoked successfully") });
      invalidate();
    },
    onError: (error) => {
      notifications.show({
        message: errorMessage(error, t("Could not revoke the API key")),
        color: "red",
      });
    },
  });
}
