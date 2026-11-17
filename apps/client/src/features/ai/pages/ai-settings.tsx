import { Alert, Button, Divider, Group, Loader, Stack, Switch, Text, Title, Tooltip } from "@mantine/core";
import { IconInfoCircle, IconRefresh } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";
import {
  AI_CONFIG_KEY,
  AI_EMBEDDING_STATUS_KEY,
  useAiSettingsQuery,
  useEmbeddingStatusQuery,
  useReindexEmbeddingsMutation,
  useUpdateAiSettingsMutation,
} from "@/features/ai/queries";
import { AI_PROVIDER_IDS, AiEmbeddingStatus } from "@/features/ai/types";
import ProviderCard from "@/features/ai/components/provider-card";
import ModelChoiceSelect from "@/features/ai/components/model-choice";
import { formatDateTime } from "@/features/audit/lib/audit-time";

// Settings > AI: connect providers, pick models, switch the features on.
export default function AiSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAiSettingsQuery();
  const { data: status } = useEmbeddingStatusQuery(isAdmin);
  const update = useUpdateAiSettingsMutation();
  const reindex = useReindexEmbeddingsMutation();

  if (!isAdmin) return null;

  const generativeOn = workspace?.settings?.ai?.generative === true;
  const searchOn = workspace?.settings?.ai?.search === true;
  const chatOn = workspace?.settings?.ai?.chat === true;
  const hasGenerationModel = Boolean(settings?.generation) || Boolean(settings?.envFallback?.model);
  const hasEmbeddingModel = Boolean(settings?.embedding) || Boolean(status?.model);
  const vectorStoreReady = status ? status.available : true;

  const toggleGenerative = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ generativeAi: value });
      setWorkspace(updated);
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to update setting")), color: "red" });
    }
  };

  const toggleSearch = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ aiSearch: value });
      setWorkspace(updated);
      queryClient.invalidateQueries({ queryKey: AI_EMBEDDING_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: AI_CONFIG_KEY });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to update setting")), color: "red" });
    }
  };

  const toggleChatFlag = async (
    key: "aiChat" | "aiChatReadOnly" | "aiChatWorkspaceKnowledgeOnly",
    value: boolean,
  ) => {
    try {
      const updated = await updateWorkspace({ [key]: value } as any);
      setWorkspace(updated);
      queryClient.invalidateQueries({ queryKey: AI_CONFIG_KEY });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to update setting")), color: "red" });
    }
  };

  const searchHint = !vectorStoreReady
    ? t("The database has no pgvector extension. Use the pgvector/pgvector Postgres image, then restart.")
    : !hasEmbeddingModel
      ? t("Pick an embedding model first.")
      : t("Members get an AI Answers switch in search: a question is answered from the pages they can read, with sources.");

  return (
    <>
      <DocumentTitle title={t("AI")} />
      <SettingsTitle title={t("AI")} />

      <Text size="sm" c="dimmed" mb="lg">
        {t("Bring your own provider. Keys are stored encrypted on this server and never sent to anyone but that provider.")}
      </Text>

      <Title order={4} mb="sm">
        {t("Providers")}
      </Title>
      {isLoading || !settings ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="sm">
          {AI_PROVIDER_IDS.map((id) => (
            <ProviderCard key={id} id={id} provider={settings.providers[id]} />
          ))}
        </Stack>
      )}

      <Divider my="xl" />

      <Title order={4} mb="xs">
        {t("Models")}
      </Title>
      {settings?.envFallback && !settings.generation && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light" mb="sm">
          {t("Using the model from the server environment ({{provider}} / {{model}}) until you pick one here.", {
            provider: settings.envFallback.provider,
            model: settings.envFallback.model ?? "?",
          })}
        </Alert>
      )}
      {settings && (
        <Stack gap="md">
          <ResponsiveSettingsRow>
            <ResponsiveSettingsContent>
              <Text size="md">{t("Writing model")}</Text>
              <Text size="sm" c="dimmed">
                {t("Used by Ask AI in the editor and to write AI answers in search.")}
              </Text>
            </ResponsiveSettingsContent>
            <ResponsiveSettingsControl>
              <ModelChoiceSelect
                settings={settings}
                kind="chat"
                value={settings.generation}
                onChange={(choice) => update.mutate({ generation: choice })}
                saving={update.isPending}
              />
            </ResponsiveSettingsControl>
          </ResponsiveSettingsRow>
          <ResponsiveSettingsRow>
            <ResponsiveSettingsContent>
              <Text size="md">{t("Embedding model")}</Text>
              <Text size="sm" c="dimmed">
                {t("Turns pages into vectors for AI search. Changing it re-indexes every page.")}
              </Text>
            </ResponsiveSettingsContent>
            <ResponsiveSettingsControl>
              <ModelChoiceSelect
                settings={settings}
                kind="embedding"
                value={settings.embedding}
                onChange={(choice) => update.mutate({ embedding: choice })}
                saving={update.isPending}
              />
            </ResponsiveSettingsControl>
          </ResponsiveSettingsRow>
        </Stack>
      )}

      <Divider my="xl" />

      <Title order={4} mb="xs">
        {t("Features")}
      </Title>
      <Stack gap="md">
        <ResponsiveSettingsRow>
          <ResponsiveSettingsContent>
            <Text size="md">{t("Ask AI in the editor")}</Text>
            <Text size="sm" c="dimmed">
              {hasGenerationModel
                ? t("Members get an Ask AI button to rewrite, fix, summarize, translate or continue text.")
                : t("Pick a writing model first.")}
            </Text>
          </ResponsiveSettingsContent>
          <ResponsiveSettingsControl>
            <Tooltip label={t("Pick a writing model first.")} disabled={hasGenerationModel || generativeOn} refProp="rootRef">
              <Switch
                checked={generativeOn}
                onChange={(e) => toggleGenerative(e.currentTarget.checked)}
                disabled={!hasGenerationModel && !generativeOn}
                aria-label={t("Toggle Ask AI")}
              />
            </Tooltip>
          </ResponsiveSettingsControl>
        </ResponsiveSettingsRow>
        <ResponsiveSettingsRow>
          <ResponsiveSettingsContent>
            <Text size="md">{t("AI search")}</Text>
            <Text size="sm" c="dimmed">
              {searchHint}
            </Text>
          </ResponsiveSettingsContent>
          <ResponsiveSettingsControl>
            <Tooltip label={searchHint} disabled={(hasEmbeddingModel && vectorStoreReady) || searchOn} refProp="rootRef">
              <Switch
                checked={searchOn}
                onChange={(e) => toggleSearch(e.currentTarget.checked)}
                disabled={(!hasEmbeddingModel || !vectorStoreReady) && !searchOn}
                aria-label={t("Toggle AI search")}
              />
            </Tooltip>
          </ResponsiveSettingsControl>
        </ResponsiveSettingsRow>
        {searchOn && status && <IndexStatus status={status} onReindex={() => reindex.mutate()} busy={reindex.isPending} />}
        <ResponsiveSettingsRow>
          <ResponsiveSettingsContent>
            <Text size="md">{t("AI chat")}</Text>
            <Text size="sm" c="dimmed">
              {hasGenerationModel
                ? t("A chat at /ai and beside every page that searches, reads and, if you allow it, writes pages as the member asking.")
                : t("Pick a writing model first.")}
            </Text>
          </ResponsiveSettingsContent>
          <ResponsiveSettingsControl>
            <Tooltip label={t("Pick a writing model first.")} disabled={hasGenerationModel || chatOn} refProp="rootRef">
              <Switch
                checked={chatOn}
                onChange={(e) => toggleChatFlag("aiChat", e.currentTarget.checked)}
                disabled={!hasGenerationModel && !chatOn}
                aria-label={t("Toggle AI chat")}
              />
            </Tooltip>
          </ResponsiveSettingsControl>
        </ResponsiveSettingsRow>
        {chatOn && (
          <>
            <ResponsiveSettingsRow>
              <ResponsiveSettingsContent>
                <Text size="md">{t("Chat is read-only")}</Text>
                <Text size="sm" c="dimmed">
                  {t("The chat can search and read pages but never create or change them.")}
                </Text>
              </ResponsiveSettingsContent>
              <ResponsiveSettingsControl>
                <Switch
                  checked={workspace?.settings?.ai?.chatReadOnly === true}
                  onChange={(e) => toggleChatFlag("aiChatReadOnly", e.currentTarget.checked)}
                  aria-label={t("Toggle read-only chat")}
                />
              </ResponsiveSettingsControl>
            </ResponsiveSettingsRow>
            <ResponsiveSettingsRow>
              <ResponsiveSettingsContent>
                <Text size="md">{t("Workspace knowledge only")}</Text>
                <Text size="sm" c="dimmed">
                  {t("Answers come only from your pages; the model says so instead of using general knowledge.")}
                </Text>
              </ResponsiveSettingsContent>
              <ResponsiveSettingsControl>
                <Switch
                  checked={workspace?.settings?.ai?.chatWorkspaceKnowledgeOnly === true}
                  onChange={(e) => toggleChatFlag("aiChatWorkspaceKnowledgeOnly", e.currentTarget.checked)}
                  aria-label={t("Toggle workspace knowledge only")}
                />
              </ResponsiveSettingsControl>
            </ResponsiveSettingsRow>
          </>
        )}
      </Stack>
    </>
  );
}

function IndexStatus({
  status,
  onReindex,
  busy,
}: {
  status: AiEmbeddingStatus;
  onReindex: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const working = status.pendingPages > 0 || status.queuedJobs > 0;
  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Search index")}</Text>
        <Text size="sm" c="dimmed">
          {t("{{indexed}} of {{total}} pages indexed", {
            indexed: status.indexedPages,
            total: status.totalPages,
          })}
          {status.pendingPages > 0 && ` · ${t("{{count}} pending", { count: status.pendingPages })}`}
          {status.lastIndexedAt && ` · ${t("updated {{time}}", { time: formatDateTime(status.lastIndexedAt) })}`}
        </Text>
        {!status.model && (
          <Text size="sm" c="red">
            {t("No embedding model is chosen; nothing is indexed until you pick one.")}
          </Text>
        )}
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Group gap="xs" wrap="nowrap">
          {working && <Loader size="xs" />}
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={onReindex}
            loading={busy}
            disabled={!status.model}
          >
            {t("Re-index all pages")}
          </Button>
        </Group>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
