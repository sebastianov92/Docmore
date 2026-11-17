import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { IPagination } from "@/lib/types.ts";
import {
  createSsoProvider,
  deleteSsoProvider,
  getSsoProviders,
  updateSsoProvider,
} from "@/features/sso/services/sso-service.ts";
import {
  ICreateSsoProvider,
  ISsoProvider,
  IUpdateSsoProvider,
} from "@/features/sso/types/sso.types.ts";

export const SSO_PROVIDERS_KEY = ["sso-providers"];

export function useSsoProvidersQuery(): UseQueryResult<
  IPagination<ISsoProvider>,
  Error
> {
  return useQuery({
    queryKey: SSO_PROVIDERS_KEY,
    queryFn: getSsoProviders,
    staleTime: 60 * 1000,
  });
}

function errorMessage(error: unknown): string {
  return (error as any)?.response?.data?.message ?? (error as Error)?.message;
}

export function useCreateSsoProviderMutation() {
  const queryClient = useQueryClient();
  return useMutation<ISsoProvider, Error, ICreateSsoProvider>({
    mutationFn: createSsoProvider,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SSO_PROVIDERS_KEY });
    },
    onError: (error) => {
      notifications.show({ message: errorMessage(error), color: "red" });
    },
  });
}

export function useUpdateSsoProviderMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation<ISsoProvider, Error, IUpdateSsoProvider>({
    mutationFn: updateSsoProvider,
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: SSO_PROVIDERS_KEY });
      // The login page reads the enabled providers from the public workspace data.
      queryClient.invalidateQueries({ queryKey: ["workspace-public"] });
    },
    onError: (error) => {
      notifications.show({ message: errorMessage(error), color: "red" });
    },
  });
}

export function useDeleteSsoProviderMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteSsoProvider,
    onSuccess: () => {
      notifications.show({ message: t("Deleted successfully") });
      queryClient.invalidateQueries({ queryKey: SSO_PROVIDERS_KEY });
      queryClient.invalidateQueries({ queryKey: ["workspace-public"] });
    },
    onError: (error) => {
      notifications.show({ message: errorMessage(error), color: "red" });
    },
  });
}
