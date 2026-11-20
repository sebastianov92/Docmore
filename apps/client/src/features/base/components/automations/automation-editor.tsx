import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ActionIcon, Button, Group, Select, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { IconFilter, IconPlus, IconTrash } from "@tabler/icons-react";
import {
  AutomationAction,
  AutomationTrigger,
  FilterCondition,
  IAutomation,
  IBase,
} from "@/features/base/types/base.types";
import { listBases, listForms } from "@/features/base/services/base-service";
import { useBaseQuery } from "@/features/base/queries/base-query";
import { ViewFilterConfigPopover } from "@/features/base/components/views/view-filter-config";
import { isSystemPropertyType } from "@/features/base/hooks/use-base-table";

export type AutomationDraft = {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: FilterCondition[];
  actions: AutomationAction[];
};

export function draftFrom(a: IAutomation | null): AutomationDraft {
  return {
    name: a?.name ?? "",
    enabled: a?.enabled ?? true,
    trigger: a?.trigger ?? { type: "row.created" },
    conditions: (a?.conditions?.children ?? []).filter((c): c is FilterCondition => "propertyId" in c),
    actions: a?.actions?.length ? a.actions : [{ type: "set_cells", cells: {} }],
  };
}

type Props = {
  base: IBase;
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
};

// One automation: when (trigger), if (conditions), then (actions).
export function AutomationEditor({ base, draft, onChange }: Props) {
  const { t } = useTranslation();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { data: forms } = useQuery({ queryKey: ["base-forms", base.id], queryFn: () => listForms(base.id) });
  const writable = base.properties.filter((p) => !isSystemPropertyType(p.type) && p.type !== "button");
  const set = (patch: Partial<AutomationDraft>) => onChange({ ...draft, ...patch });
  const setAction = (i: number, action: AutomationAction) => set({ actions: draft.actions.map((a, j) => (j === i ? action : a)) });
  const triggerType = draft.trigger.type;

  return (
    <Stack gap="sm" data-testid="automation-editor">
      <TextInput size="xs" label={t("Name")} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} placeholder={t("When a task is done, notify the owner")} />
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          label={t("When")}
          w={220}
          value={triggerType}
          allowDeselect={false}
          onChange={(v) => v && set({ trigger: { type: v } as AutomationTrigger })}
          data={[
            { value: "row.created", label: t("A row is created") },
            { value: "row.updated", label: t("A row changes") },
            { value: "form.submitted", label: t("A form is submitted") },
            { value: "button", label: t("A button is pressed") },
          ]}
          comboboxProps={{ withinPortal: true }}
        />
        {triggerType === "row.updated" && (
          <Select
            size="xs"
            label={t("Property")}
            w={200}
            placeholder={t("Any property")}
            clearable
            value={(draft.trigger as { propertyId?: string }).propertyId ?? null}
            onChange={(v) => set({ trigger: { type: "row.updated", ...(v ? { propertyId: v } : {}) } })}
            data={writable.map((p) => ({ value: p.id, label: p.name }))}
            comboboxProps={{ withinPortal: true }}
          />
        )}
        {triggerType === "form.submitted" && (
          <Select
            size="xs"
            label={t("Form")}
            w={200}
            placeholder={t("Any form")}
            clearable
            value={(draft.trigger as { formId?: string }).formId ?? null}
            onChange={(v) => set({ trigger: { type: "form.submitted", ...(v ? { formId: v } : {}) } })}
            data={(forms?.items ?? []).map((f) => ({ value: f.id, label: f.name }))}
            comboboxProps={{ withinPortal: true }}
          />
        )}
      </Group>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          {t("Only if")}
        </Text>
        <ViewFilterConfigPopover
          opened={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          conditions={draft.conditions}
          properties={base.properties}
          onChange={(conditions) => set({ conditions })}
        >
          <Button size="compact-xs" variant="light" leftSection={<IconFilter size={12} />} onClick={() => setFiltersOpen((o) => !o)}>
            {draft.conditions.length ? t("{{count}} conditions", { count: draft.conditions.length }) : t("Always")}
          </Button>
        </ViewFilterConfigPopover>
      </Group>
      <Text size="xs" c="dimmed">
        {t("Then")}
      </Text>
      {draft.actions.map((action, i) => (
        <Group key={i} gap="xs" align="flex-start" wrap="nowrap" data-testid="automation-action">
          <Stack gap={6} style={{ flex: 1 }}>
            <Select
              size="xs"
              w={220}
              value={action.type}
              allowDeselect={false}
              onChange={(v) => {
                if (!v) return;
                const blank: Record<string, AutomationAction> = {
                  set_cells: { type: "set_cells", cells: {} },
                  create_row: { type: "create_row", cells: {} },
                  notify: { type: "notify", message: "", notifyCreator: true },
                  webhook: { type: "webhook", url: "" },
                };
                setAction(i, blank[v]);
              }}
              data={[
                { value: "set_cells", label: t("Set a cell of the row") },
                { value: "create_row", label: t("Create a row") },
                { value: "notify", label: t("Notify people") },
                { value: "webhook", label: t("Call a webhook") },
              ]}
              comboboxProps={{ withinPortal: true }}
            />
            <ActionFields base={base} action={action} onChange={(a) => setAction(i, a)} />
          </Stack>
          <ActionIcon variant="subtle" color="gray" size="sm" mt={22} onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })} disabled={draft.actions.length === 1} aria-label={t("Remove action")}>
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => set({ actions: [...draft.actions, { type: "notify", message: "", notifyCreator: true }] })} disabled={draft.actions.length >= 10}>
        {t("Add action")}
      </Button>
      <Text size="xs" c="dimmed">
        {t("Values may use {{now}}, {{today}}, {{actor}}, {{title}} and {{row.<property id>}}.")}
      </Text>
      <Switch size="xs" label={t("Enabled")} checked={draft.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
    </Stack>
  );
}

function CellValueInput({ base, cells, onChange }: { base: IBase; cells: Record<string, unknown>; onChange: (cells: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const writable = base.properties.filter((p) => !isSystemPropertyType(p.type) && p.type !== "button");
  const propertyId = Object.keys(cells)[0] ?? null;
  const property = writable.find((p) => p.id === propertyId);
  const raw = propertyId ? cells[propertyId] : "";
  const parse = (p: typeof property, text: string): unknown => {
    if (!p) return text;
    if (p.type === "number") return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
    if (p.type === "checkbox") return /^(true|yes|1)$/i.test(text.trim());
    if (p.type === "multiSelect" || p.type === "relation") return text.split(",").map((s) => s.trim()).filter(Boolean);
    return text;
  };
  const choiceHint = property && (property.type === "select" || property.type === "status" || property.type === "multiSelect")
    ? ((property.typeOptions as { choices?: { id: string; name: string }[] })?.choices ?? []).map((c) => `${c.name}=${c.id}`).join(" · ")
    : "";
  return (
    <Group gap="xs" align="flex-end">
      <Select
        size="xs"
        w={180}
        placeholder={t("Property")}
        value={propertyId}
        onChange={(v) => onChange(v ? { [v]: "" } : {})}
        data={writable.map((p) => ({ value: p.id, label: p.name }))}
        comboboxProps={{ withinPortal: true }}
      />
      <TextInput
        size="xs"
        style={{ flex: 1 }}
        placeholder={property?.type === "checkbox" ? "true / false" : property?.type === "select" ? t("choice id") : t("Value")}
        description={choiceHint || undefined}
        value={Array.isArray(raw) ? raw.join(", ") : raw === null || raw === undefined ? "" : String(raw)}
        onChange={(e) => propertyId && onChange({ [propertyId]: parse(property, e.currentTarget.value) })}
        disabled={!propertyId}
      />
    </Group>
  );
}

function ActionFields({ base, action, onChange }: { base: IBase; action: AutomationAction; onChange: (a: AutomationAction) => void }) {
  const { t } = useTranslation();
  const { data: bases } = useQuery({
    queryKey: ["bases", "list", base.spaceId, "all"],
    queryFn: () => listBases(base.spaceId, { limit: 100 }),
    enabled: action.type === "create_row",
  });
  const targetId = action.type === "create_row" ? action.pageId ?? base.id : base.id;
  const { data: targetBase } = useBaseQuery(action.type === "create_row" && targetId !== base.id ? targetId : "");
  const target = targetId === base.id ? base : targetBase ?? base;
  const people = useMemo(() => base.properties.filter((p) => p.type === "person"), [base.properties]);

  switch (action.type) {
    case "set_cells":
      return <CellValueInput base={base} cells={action.cells} onChange={(cells) => onChange({ ...action, cells })} />;
    case "create_row":
      return (
        <Stack gap={6}>
          <Select
            size="xs"
            w={220}
            label={t("In base")}
            value={targetId}
            allowDeselect={false}
            onChange={(v) => v && onChange({ ...action, pageId: v === base.id ? undefined : v, cells: {} })}
            data={(bases?.items ?? [{ id: base.id, name: base.name }]).map((b) => ({ value: b.id, label: b.id === base.id ? `${b.name} (${t("this base")})` : b.name }))}
            comboboxProps={{ withinPortal: true }}
          />
          <CellValueInput base={target} cells={action.cells} onChange={(cells) => onChange({ ...action, cells })} />
        </Stack>
      );
    case "notify":
      return (
        <Stack gap={6}>
          <Textarea size="xs" autosize minRows={1} placeholder={t("{{title}} is ready")} value={action.message} onChange={(e) => onChange({ ...action, message: e.currentTarget.value })} />
          <Group gap="xs">
            <Switch size="xs" label={t("Row creator")} checked={action.notifyCreator !== false} onChange={(e) => onChange({ ...action, notifyCreator: e.currentTarget.checked })} />
            {people.length > 0 && (
              <Select
                size="xs"
                w={180}
                placeholder={t("People in property…")}
                clearable
                value={action.personPropertyId ?? null}
                onChange={(v) => onChange({ ...action, personPropertyId: v ?? undefined })}
                data={people.map((p) => ({ value: p.id, label: p.name }))}
                comboboxProps={{ withinPortal: true }}
              />
            )}
          </Group>
        </Stack>
      );
    case "webhook":
      return (
        <Group gap="xs">
          <TextInput size="xs" style={{ flex: 1 }} placeholder="https://…" value={action.url} onChange={(e) => onChange({ ...action, url: e.currentTarget.value })} />
          <TextInput size="xs" w={160} placeholder={t("Secret (optional)")} value={action.secret ?? ""} onChange={(e) => onChange({ ...action, secret: e.currentTarget.value || undefined })} />
        </Group>
      );
    default:
      return null;
  }
}
