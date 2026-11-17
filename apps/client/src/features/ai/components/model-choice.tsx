import { Button, Group, Select, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { AI_PROVIDER_IDS, AiProviderId, AiSettingsView, ModelChoice } from "@/features/ai/types";

interface Props {
  settings: AiSettingsView;
  kind: "chat" | "embedding";
  value: ModelChoice | null;
  onChange: (choice: ModelChoice | null) => void;
  saving?: boolean;
}

// One dropdown over every provider's discovered models of the right kind.
export default function ModelChoiceSelect({ settings, kind, value, onChange, saving }: Props) {
  const { t } = useTranslation();
  const groups = AI_PROVIDER_IDS.map((id) => ({
    group: settings.providers[id].label,
    items: settings.providers[id].models
      .filter((m) => m.kind === kind)
      .map((m) => ({ value: `${id}::${m.id}`, label: m.label === m.id ? m.id : `${m.label} (${m.id})` })),
  })).filter((g) => g.items.length > 0);

  const current = value ? `${value.provider}::${value.model}` : null;
  // A saved model that no catalog lists any more still shows, so it can be kept or replaced.
  const known = groups.some((g) => g.items.some((i) => i.value === current));
  const data = current && !known ? [...groups, { group: t("Saved"), items: [{ value: current, label: value!.model }] }] : groups;

  return (
    <Group gap="xs" wrap="nowrap" align="flex-end">
      <Select
        data={data}
        value={current}
        onChange={(v) => {
          if (!v) return onChange(null);
          const [provider, ...rest] = v.split("::");
          onChange({ provider: provider as AiProviderId, model: rest.join("::") });
        }}
        placeholder={groups.length ? t("Choose a model") : t("Test a provider first to load its models")}
        searchable
        clearable
        nothingFoundMessage={t("No model matches")}
        disabled={saving}
        w={380}
        size="sm"
        comboboxProps={{ withinPortal: true }}
      />
      {value && (
        <Button variant="subtle" size="compact-sm" color="gray" onClick={() => onChange(null)} disabled={saving}>
          {t("Clear")}
        </Button>
      )}
      {!groups.length && (
        <Text size="xs" c="dimmed">
          {t("No models yet.")}
        </Text>
      )}
    </Group>
  );
}
