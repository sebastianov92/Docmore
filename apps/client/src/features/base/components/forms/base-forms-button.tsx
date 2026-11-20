import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Anchor, Button, Checkbox, Drawer, Group, Stack, Switch, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconForms, IconLink, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { FormField, IBase, IBaseForm } from "@/features/base/types/base.types";
import { createForm, deleteForm, listForms, updateForm } from "@/features/base/services/base-service";
import { getApiErrorMessage } from "@/lib/api-error";
import { useClipboard } from "@/hooks/use-clipboard";
import { getAppUrl } from "@/lib/config.ts";

// Types a stranger can fill in (mirrors the server's list).
const FORM_FIELD_TYPES = new Set(["text", "longText", "number", "select", "status", "multiSelect", "date", "checkbox", "url", "email", "phone"]);

type Draft = { name: string; description: string; fields: FormField[]; submitLabel: string; thanksText: string; enabled: boolean };

export function formUrl(token: string): string {
  return `${getAppUrl()}/form/${token}`;
}

// Toolbar entry: public forms that drop rows into this base.
export function BaseFormsButton({ base, canEdit }: { base: IBase; canEdit: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const clipboard = useClipboard({ timeout: 500 });
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const key = ["base-forms", base.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => listForms(base.id), enabled: opened });
  const items = data?.items ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });
  const eligible = base.properties.filter((p) => FORM_FIELD_TYPES.has(p.type) && (p.restrictedTo ?? "all") === "all");

  const blank = (): Draft => ({
    name: base.name || t("Form"),
    description: "",
    fields: eligible.filter((p) => p.isPrimary).map((p) => ({ propertyId: p.id, required: true })),
    submitLabel: "",
    thanksText: "",
    enabled: true,
  });
  const fromForm = (f: IBaseForm): Draft => ({
    name: f.name,
    description: f.description ?? "",
    fields: f.fields,
    submitLabel: f.submitLabel ?? "",
    thanksText: f.thanksText ?? "",
    enabled: f.enabled,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const d = editing.draft;
      const payload = { pageId: base.id, name: d.name, description: d.description, fields: d.fields, submitLabel: d.submitLabel, thanksText: d.thanksText, enabled: d.enabled };
      return editing.id ? updateForm({ ...payload, formId: editing.id }) : createForm(payload);
    },
    onSuccess: () => {
      refresh();
      setEditing(null);
      notifications.show({ message: t("Form saved") });
    },
    onError: fail,
  });
  const toggle = useMutation({ mutationFn: (f: IBaseForm) => updateForm({ pageId: base.id, formId: f.id, enabled: !f.enabled }), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (f: IBaseForm) => deleteForm({ pageId: base.id, formId: f.id }), onSuccess: refresh, onError: fail });

  const copyLink = (f: IBaseForm) => {
    clipboard.copy(formUrl(f.token));
    notifications.show({ message: t("Link copied") });
  };

  const setField = (propertyId: string, on: boolean) => {
    if (!editing) return;
    const fields = on
      ? [...editing.draft.fields.filter((f) => f.propertyId !== propertyId), { propertyId, required: false }]
      : editing.draft.fields.filter((f) => f.propertyId !== propertyId);
    // keep the base's property order
    fields.sort((a, b) => eligible.findIndex((p) => p.id === a.propertyId) - eligible.findIndex((p) => p.id === b.propertyId));
    setEditing({ ...editing, draft: { ...editing.draft, fields } });
  };

  return (
    <>
      <Tooltip label={t("Forms")}>
        <ActionIcon variant="subtle" size="sm" color="gray" onClick={() => setOpened(true)} aria-label={t("Forms")} data-testid="base-forms-button">
          <IconForms size={16} />
        </ActionIcon>
      </Tooltip>
      <Drawer opened={opened} onClose={() => { setOpened(false); setEditing(null); }} position="right" size="md" title={t("Forms")}>
        {editing ? (
          <Stack gap="sm" data-testid="form-editor">
            <TextInput size="xs" label={t("Title")} value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.currentTarget.value } })} />
            <Textarea size="xs" label={t("Description")} autosize minRows={1} value={editing.draft.description} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, description: e.currentTarget.value } })} />
            <Text size="xs" fw={600} c="dimmed">
              {t("Fields")}
            </Text>
            {eligible.length === 0 && (
              <Text size="xs" c="dimmed">
                {t("No property of this base can be a form field.")}
              </Text>
            )}
            {eligible.map((p) => {
              const field = editing.draft.fields.find((f) => f.propertyId === p.id);
              return (
                <Group key={p.id} gap="xs" justify="space-between" wrap="nowrap">
                  <Checkbox size="xs" label={p.name} checked={Boolean(field)} onChange={(e) => setField(p.id, e.currentTarget.checked)} />
                  {field && (
                    <Switch
                      size="xs"
                      label={t("Required")}
                      checked={Boolean(field.required)}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          draft: { ...editing.draft, fields: editing.draft.fields.map((f) => (f.propertyId === p.id ? { ...f, required: e.currentTarget.checked } : f)) },
                        })
                      }
                    />
                  )}
                </Group>
              );
            })}
            <TextInput size="xs" label={t("Submit button")} placeholder={t("Send")} value={editing.draft.submitLabel} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, submitLabel: e.currentTarget.value } })} />
            <Textarea size="xs" label={t("Thank-you message")} placeholder={t("Thanks, we got it.")} autosize minRows={1} value={editing.draft.thanksText} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, thanksText: e.currentTarget.value } })} />
            <Switch size="xs" label={t("Accepting submissions")} checked={editing.draft.enabled} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, enabled: e.currentTarget.checked } })} />
            <Group justify="flex-end" gap="xs">
              <Button size="xs" variant="subtle" color="gray" onClick={() => setEditing(null)}>
                {t("Cancel")}
              </Button>
              <Button size="xs" onClick={() => save.mutate()} loading={save.isPending} disabled={!editing.draft.name.trim() || editing.draft.fields.length === 0} data-testid="form-save">
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs" data-testid="form-list">
            {items.length === 0 && (
              <Text size="sm" c="dimmed">
                {t("A form is a public link where anyone can add a row to this base, without an account.")}
              </Text>
            )}
            {items.map((f) => (
              <Group key={f.id} gap="xs" wrap="nowrap" justify="space-between" data-testid="form-item">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={500} truncate>
                    {f.name}
                  </Text>
                  <Group gap={6}>
                    <Text size="xs" c="dimmed">
                      {t("{{count}} submissions", { count: f.submissions })}
                    </Text>
                    <Anchor size="xs" href={formUrl(f.token)} target="_blank" rel="noreferrer">
                      {t("Open form")}
                    </Anchor>
                  </Group>
                </Stack>
                <Group gap={4} wrap="nowrap">
                  {canEdit && <Switch size="xs" checked={f.enabled} onChange={() => toggle.mutate(f)} aria-label={t("Accepting submissions")} />}
                  <Tooltip label={t("Copy link")}>
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => copyLink(f)} aria-label={t("Copy link")} data-testid="form-copy-link">
                      <IconLink size={14} />
                    </ActionIcon>
                  </Tooltip>
                  {canEdit && (
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setEditing({ id: f.id, draft: fromForm(f) })} aria-label={t("Edit")}>
                      <IconPencil size={14} />
                    </ActionIcon>
                  )}
                  {canEdit && (
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => remove.mutate(f)} aria-label={t("Delete")}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  )}
                </Group>
              </Group>
            ))}
            {canEdit && (
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ id: null, draft: blank() })} data-testid="form-new">
                {t("New form")}
              </Button>
            )}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
