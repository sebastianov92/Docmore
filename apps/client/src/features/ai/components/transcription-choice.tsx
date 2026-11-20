import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Select, Text, TextInput } from "@mantine/core";
import { AiProviderId, AiSettingsView, ModelChoice } from "@/features/ai/types";
import { ResponsiveSettingsContent, ResponsiveSettingsControl, ResponsiveSettingsRow } from "@/components/ui/responsive-settings-row";

const PROVIDERS: AiProviderId[] = ["openai", "compatible", "gemini"];

// Speech to text: a provider that can hear audio and the model name, which
// is not in the chat model lists (whisper-1, gpt-4o-transcribe, a local
// faster-whisper model, gemini-2.5-flash...).
export function TranscriptionChoice({ settings, onChange, saving }: { settings: AiSettingsView; onChange: (choice: ModelChoice | null) => void; saving?: boolean }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<AiProviderId>(settings.transcription?.provider ?? "openai");
  const [model, setModel] = useState(settings.transcription?.model ?? "");
  useEffect(() => {
    setProvider(settings.transcription?.provider ?? "openai");
    setModel(settings.transcription?.model ?? "");
  }, [settings.transcription?.provider, settings.transcription?.model]);
  const dirty = provider !== (settings.transcription?.provider ?? "openai") || model.trim() !== (settings.transcription?.model ?? "");

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Transcription model")}</Text>
        <Text size="sm" c="dimmed">
          {t("For meeting notes from a recording. OpenAI and compatible servers use /audio/transcriptions (whisper-1, gpt-4o-transcribe, a local Whisper); Gemini listens to the file itself.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <Select
            size="xs"
            w={150}
            data={PROVIDERS.map((id) => ({ value: id, label: settings.providers[id].label }))}
            value={provider}
            onChange={(v) => v && setProvider(v as AiProviderId)}
            allowDeselect={false}
            aria-label={t("Transcription provider")}
          />
          <TextInput size="xs" w={190} placeholder="whisper-1" value={model} onChange={(e) => setModel(e.currentTarget.value)} aria-label={t("Transcription model")} data-testid="transcription-model" />
          <Button size="xs" variant="default" onClick={() => onChange(model.trim() ? { provider, model: model.trim() } : null)} disabled={!dirty} loading={saving}>
            {t("Save")}
          </Button>
        </Group>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
