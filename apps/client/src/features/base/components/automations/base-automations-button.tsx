import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Drawer, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBolt, IconPencil, IconPlayerPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { IAutomation, IBase } from "@/features/base/types/base.types";
import { createAutomation, deleteAutomation, listAutomations, runAutomation, updateAutomation } from "@/features/base/services/base-service";
import { getApiErrorMessage } from "@/lib/api-error";
import { AutomationDraft, AutomationEditor, draftFrom } from "./automation-editor";

const TRIGGER_LABEL: Record<string, string> = {
  "row.created": "A row is created",
  "row.updated": "A row changes",
  "form.submitted": "A form is submitted",
  button: "A button is pressed",
};

// Toolbar entry: the base's automations, with an editor for each.
export function BaseAutomationsButton({ base, canEdit }: { base: IBase; canEdit: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: AutomationDraft } | null>(null);
  const key = ["base-automations", base.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => listAutomations(base.id), enabled: opened });
  const items = data?.items ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const d = editing.draft;
      const conditions = d.conditions.length ? { op: "and" as const, children: d.conditions } : null;
      if (editing.id) return updateAutomation({ pageId: base.id, automationId: editing.id, name: d.name, enabled: d.enabled, trigger: d.trigger, conditions, actions: d.actions });
      return createAutomation({ pageId: base.id, name: d.name, enabled: d.enabled, trigger: d.trigger, conditions, actions: d.actions });
    },
    onSuccess: () => {
      refresh();
      setEditing(null);
      notifications.show({ message: t("Automation saved") });
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (a: IAutomation) => updateAutomation({ pageId: base.id, automationId: a.id, enabled: !a.enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (a: IAutomation) => deleteAutomation({ pageId: base.id, automationId: a.id }),
    onSuccess: refresh,
    onError: fail,
  });
  const run = useMutation({
    mutationFn: (a: IAutomation) => runAutomation({ pageId: base.id, automationId: a.id }),
    onSuccess: (r) => {
      refresh();
      notifications.show({ message: r.ok === false ? r.errors?.join("; ") || t("Automation failed") : t("Done"), color: r.ok === false ? "red" : undefined });
    },
    onError: fail,
  });

  return (
    <>
      <Tooltip label={t("Automations")}>
        <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => setOpened(true)} aria-label={t("Automations")} data-testid="base-automations-button">
          <IconBolt size={16} />
        </ActionIcon>
      </Tooltip>
      <Drawer opened={opened} onClose={() => { setOpened(false); setEditing(null); }} position="right" size="lg" title={t("Automations")}>
        {editing ? (
          <Stack gap="sm">
            <AutomationEditor base={base} draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
            <Group justify="flex-end" gap="xs">
              <Button size="xs" variant="subtle" color="gray" onClick={() => setEditing(null)}>
                {t("Cancel")}
              </Button>
              <Button size="xs" onClick={() => save.mutate()} loading={save.isPending} disabled={!editing.draft.name.trim()} data-testid="automation-save">
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs" data-testid="automation-list">
            {items.length === 0 && (
              <Text size="sm" c="dimmed">
                {t("No automations yet. They run when rows appear or change, when a form is submitted, or when someone presses a button.")}
              </Text>
            )}
            {items.map((a) => (
              <Group key={a.id} gap="xs" wrap="nowrap" justify="space-between" data-testid="automation-item">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500} truncate>
                      {a.name}
                    </Text>
                    <Badge size="xs" variant="light" color="gray" style={{ textTransform: "none" }}>
                      {t(TRIGGER_LABEL[a.trigger?.type] ?? a.trigger?.type)}
                    </Badge>
                  </Group>
                  <Text size="xs" c={a.lastError ? "red" : "dimmed"} truncate>
                    {a.lastError ? a.lastError : t("{{count}} runs", { count: a.runCount })}
                  </Text>
                </Stack>
                <Group gap={4} wrap="nowrap">
                  {canEdit && <Switch size="xs" checked={a.enabled} onChange={() => toggle.mutate(a)} aria-label={t("Enabled")} />}
                  {canEdit && (
                    <Tooltip label={t("Run now")}>
                      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => run.mutate(a)} loading={run.isPending && run.variables?.id === a.id} aria-label={t("Run now")}>
                        <IconPlayerPlay size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {canEdit && (
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setEditing({ id: a.id, draft: draftFrom(a) })} aria-label={t("Edit")}>
                      <IconPencil size={14} />
                    </ActionIcon>
                  )}
                  {canEdit && (
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(a)} aria-label={t("Delete")}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  )}
                </Group>
              </Group>
            ))}
            {canEdit && (
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ id: null, draft: draftFrom(null) })} data-testid="automation-new">
                {t("New automation")}
              </Button>
            )}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
