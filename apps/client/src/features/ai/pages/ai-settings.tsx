import { Alert, Divider, Loader, Stack, Switch, Text, Title, Tooltip } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
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
import { useAiSettingsQuery, useUpdateAiSettingsMutation } from "@/features/ai/queries";
import { AI_PROVIDER_IDS } from "@/features/ai/types";
import ProviderCard from "@/features/ai/components/provider-card";
import ModelChoiceSelect from "@/features/ai/components/model-choice";

// Settings > AI: connect providers, pick models, switch the features on.
export default function AiSettings() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { data: settings, isLoading } = useAiSettingsQuery();
  const update = useUpdateAiSettingsMutation();

  if (!isAdmin) return null;

  const generativeOn = workspace?.settings?.ai?.generative === true;
  const hasGenerationModel = Boolean(settings?.generation) || Boolean(settings?.envFallback?.model);

  const toggleGenerative = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ generativeAi: value });
      setWorkspace(updated);
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Failed to update setting")), color: "red" });
    }
  };

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
                {t("Used by Ask AI in the editor: improve, summarize, translate, continue writing.")}
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
                {t("For semantic search and chat over your pages. Saved now, used once AI search is available.")}
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
            <Text size="md">{t("AI search and chat")}</Text>
            <Text size="sm" c="dimmed">
              {t("Semantic search over pages and a chat that answers from them. Coming in the next update; the embedding model above is already used for it.")}
            </Text>
          </ResponsiveSettingsContent>
          <ResponsiveSettingsControl>
            <Switch checked={false} disabled aria-label={t("AI search (not available yet)")} />
          </ResponsiveSettingsControl>
        </ResponsiveSettingsRow>
      </Stack>
    </>
  );
}
