import { useEffect, useState } from "react";
import { Badge, Button, Card, Group, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { IconCheck, IconPlugConnected } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useListModelsMutation, useUpdateAiSettingsMutation } from "@/features/ai/queries";
import { AiProviderId, AiProviderView } from "@/features/ai/types";
import { formatDateTime } from "@/features/audit/lib/audit-time";

interface Props {
  id: AiProviderId;
  provider: AiProviderView;
}

const HINTS: Record<AiProviderId, string> = {
  openai: "Key from platform.openai.com. Chat and embedding models.",
  anthropic: "Key from console.anthropic.com. Claude models for writing and chat; no embeddings.",
  gemini: "Key from aistudio.google.com. Gemini models and text embeddings.",
  ollama: "Local models, no key. Point it at your Ollama server; the app server must reach that address.",
  compatible: "Any server speaking the OpenAI API: LM Studio, vLLM, LiteLLM, OpenRouter, Groq.",
};

// One provider: credentials, a connection test that loads its models, and
// the catalog that test produced.
export default function ProviderCard({ id, provider }: Props) {
  const { t } = useTranslation();
  const update = useUpdateAiSettingsMutation();
  const listModels = useListModelsMutation();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [name, setName] = useState(provider.name ?? "");

  useEffect(() => {
    setBaseUrl(provider.baseUrl ?? "");
    setName(provider.name ?? "");
  }, [provider.baseUrl, provider.name]);

  const urlDirty = (provider.baseUrl ?? "") !== baseUrl.trim().replace(/\/+$/, "");
  const nameDirty = (provider.name ?? "") !== name.trim();
  const dirty = apiKey.trim().length > 0 || urlDirty || nameDirty;
  const ready = provider.needsApiKey ? provider.hasApiKey || apiKey.trim().length > 0 : true;
  const chatCount = provider.models.filter((m) => m.kind === "chat").length;
  const embeddingCount = provider.models.length - chatCount;

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (urlDirty) patch.baseUrl = baseUrl.trim();
    if (nameDirty) patch.name = name.trim();
    await update.mutateAsync({ providers: { [id]: patch } });
    setApiKey("");
  };

  // Save first when something changed, then ask the provider for its models.
  const test = async () => {
    if (dirty) await save();
    await listModels.mutateAsync({ provider: id });
  };

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <div>
            <Text fw={600}>{provider.label}</Text>
            <Text size="xs" c="dimmed">
              {t(HINTS[id])}
            </Text>
          </div>
          {provider.models.length > 0 ? (
            <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>
              {t("{{chat}} chat · {{embed}} embedding", { chat: chatCount, embed: embeddingCount })}
            </Badge>
          ) : provider.needsApiKey && !provider.hasApiKey ? (
            <Badge color="gray" variant="light">
              {t("No key")}
            </Badge>
          ) : null}
        </Group>

        {provider.needsApiKey || id === "compatible" ? (
          <PasswordInput
            label={t("API key")}
            placeholder={provider.hasApiKey ? t("A key is stored. Paste a new one to replace it.") : t("Paste the API key")}
            value={apiKey}
            onChange={(e) => setApiKey(e.currentTarget.value)}
            autoComplete="off"
            size="sm"
          />
        ) : null}

        {(id === "ollama" || id === "compatible" || id === "openai") && (
          <TextInput
            label={t("Base URL")}
            placeholder={provider.defaultBaseUrl ?? "https://…/v1"}
            description={
              id === "ollama"
                ? t("From inside Docker, localhost is the container; use host.docker.internal or the machine's IP.")
                : id === "openai"
                  ? t("Leave empty for api.openai.com. Set it for a proxy or Azure-style endpoint.")
                  : t("The root that contains /models and /chat/completions, usually ending in /v1.")
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            size="sm"
          />
        )}
        {id === "compatible" && (
          <TextInput
            label={t("Name")}
            placeholder={t("e.g. LM Studio")}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            size="sm"
            w={240}
          />
        )}

        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text size="xs" c="dimmed">
            {provider.checkedAt
              ? t("Models loaded {{when}}", { when: formatDateTime(provider.checkedAt) })
              : t("Not tested yet")}
          </Text>
          <Group gap="xs">
            {provider.hasApiKey && (
              <Button
                variant="subtle"
                color="red"
                size="compact-sm"
                onClick={() => update.mutate({ providers: { [id]: { clearApiKey: true } } })}
                loading={update.isPending}
              >
                {t("Remove key")}
              </Button>
            )}
            {dirty && (
              <Button variant="default" size="compact-sm" onClick={save} loading={update.isPending}>
                {t("Save")}
              </Button>
            )}
            <Button
              size="compact-sm"
              leftSection={<IconPlugConnected size={14} />}
              onClick={test}
              disabled={!ready}
              loading={listModels.isPending || update.isPending}
            >
              {t("Test and load models")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
