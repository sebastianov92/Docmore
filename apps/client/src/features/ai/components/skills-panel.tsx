import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Group, Modal, Stack, Switch, Text, Textarea, TextInput, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconSparkles } from "@tabler/icons-react";
import { createSkill, deleteSkill, ISkill, listSkills, SKILLS_KEY, updateSkill } from "@/features/ai/skills/services";
import { getApiErrorMessage } from "@/lib/api-error";

type Draft = { id?: string; name: string; description: string; instructions: string; enabled: boolean };
const empty: Draft = { name: "", description: "", instructions: "", enabled: true };

// Skills: reusable instructions for the chat and Ask AI. Whole rows open the editor.
export function SkillsPanel({ scope }: { scope: "workspace" | "personal" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: SKILLS_KEY, queryFn: () => listSkills(false) });
  const items = (data?.items ?? []).filter((s) => s.scope === scope);
  const [draft, setDraft] = useState<Draft | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
  const fail = (err: unknown) => notifications.show({ color: "red", message: getApiErrorMessage(err) });
  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? updateSkill({ skillId: d.id, name: d.name, description: d.description || null, instructions: d.instructions, enabled: d.enabled })
        : createSkill({ name: d.name, description: d.description || undefined, instructions: d.instructions, scope }),
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: deleteSkill,
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
    onError: fail,
  });

  return (
    <Stack gap="sm" data-testid={`skills-${scope}`}>
      <Text size="sm" c="dimmed">
        {scope === "workspace"
          ? t("Instructions everyone can pick in the chat with / and in Ask AI. They also show up as prompts in the MCP server.")
          : t("Your own instructions, picked in the chat with / and in Ask AI.")}
      </Text>
      {items.map((s: ISkill) => (
        <UnstyledButton
          key={s.id}
          onClick={() => setDraft({ id: s.id, name: s.name, description: s.description ?? "", instructions: s.instructions, enabled: s.enabled })}
          style={{ display: "block", width: "100%", border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: "8px 12px" }}
          data-testid="skill-row"
        >
          <Group justify="space-between" wrap="nowrap">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <IconSparkles size={14} />
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {s.name} <Text span size="xs" c="dimmed">/{s.slug}</Text>
                </Text>
                {s.description && (
                  <Text size="xs" c="dimmed" truncate>
                    {s.description}
                  </Text>
                )}
              </div>
            </Group>
            <Group gap={6} wrap="nowrap">
              {!s.enabled && (
                <Badge size="xs" color="gray" variant="light">
                  {t("off")}
                </Badge>
              )}
              <Text size="xs" c="dimmed">
                {t("used {{count}} times", { count: s.useCount })}
              </Text>
            </Group>
          </Group>
        </UnstyledButton>
      ))}
      <div>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setDraft({ ...empty })} data-testid="skill-add">
          {t("New skill")}
        </Button>
      </div>
      <Modal opened={Boolean(draft)} onClose={() => setDraft(null)} title={draft?.id ? t("Edit skill") : t("New skill")} size="lg">
        {draft && (
          <Stack gap="sm">
            <TextInput label={t("Name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} data-autofocus />
            <TextInput label={t("Description")} description={t("Shown in the picker")} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} />
            <Textarea
              label={t("Instructions")}
              description={t("What the model should do when this skill is picked. Markdown is fine.")}
              autosize
              minRows={6}
              maxRows={18}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.currentTarget.value })}
            />
            {draft.id && <Switch label={t("Enabled")} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />}
            <Group justify="space-between">
              {draft.id ? (
                <Button variant="subtle" color="red" onClick={() => remove.mutate(draft.id!)} loading={remove.isPending}>
                  {t("Delete")}
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!draft.name.trim() || !draft.instructions.trim()} data-testid="skill-save">
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
