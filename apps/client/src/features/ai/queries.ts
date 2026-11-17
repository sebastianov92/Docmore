import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  getAiConfig,
  getAiSettings,
  getEmbeddingStatus,
  listProviderModels,
  reindexEmbeddings,
  updateAiSettings,
} from "./services";
import { AiEmbeddingStatus, AiProviderId, AiSettingsView } from "./types";

export const AI_CONFIG_KEY = ["ai-config"];
export const AI_SETTINGS_KEY = ["ai-settings"];

export function useAiConfigQuery(enabled = true) {
  return useQuery({ queryKey: AI_CONFIG_KEY, queryFn: getAiConfig, enabled, staleTime: 60_000 });
}

export function useAiSettingsQuery() {
  return useQuery({ queryKey: AI_SETTINGS_KEY, queryFn: getAiSettings });
}

export function useUpdateAiSettingsMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: updateAiSettings,
    onSuccess: (view: AiSettingsView) => {
      queryClient.setQueryData(AI_SETTINGS_KEY, view);
      queryClient.invalidateQueries({ queryKey: AI_CONFIG_KEY });
    },
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to save AI settings")), color: "red" });
    },
  });
}

export function useListModelsMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (data: { provider: AiProviderId; apiKey?: string; baseUrl?: string }) => listProviderModels(data),
    onSuccess: () => {
      // The server remembers the catalog; reload the view to show it.
      queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEY });
    },
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t("Could not list models")), color: "red" });
    },
  });
}

export const AI_EMBEDDING_STATUS_KEY = ["ai-embedding-status"];

// Polls faster while the index is being built.
export function useEmbeddingStatusQuery(enabled = true) {
  return useQuery({
    queryKey: AI_EMBEDDING_STATUS_KEY,
    queryFn: getEmbeddingStatus,
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status?.enabled) return 30_000;
      return status.pendingPages > 0 || status.queuedJobs > 0 ? 4_000 : 30_000;
    },
  });
}

export function useReindexEmbeddingsMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: reindexEmbeddings,
    onSuccess: (status: AiEmbeddingStatus) => {
      queryClient.setQueryData(AI_EMBEDDING_STATUS_KEY, status);
      notifications.show({ message: t("Re-indexing every page in the background") });
    },
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t("Could not start re-indexing")), color: "red" });
    },
  });
}
