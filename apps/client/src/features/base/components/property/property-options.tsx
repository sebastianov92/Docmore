import {
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  Stack,
  NumberInput,
  Select,
  Switch,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import {
  IBaseProperty,
  SelectTypeOptions,
  NumberTypeOptions,
  DateTypeOptions,
  PersonTypeOptions,
  Choice,
  IdTypeOptions,
  RelationTypeOptions,
  RollupTypeOptions,
  ButtonTypeOptions,
  AiFillOptions,
} from "@/features/base/types/base.types";
import { ChoiceEditor } from "./choice-editor";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useBaseQuery } from "@/features/base/queries/base-query";
import {
  listBases,
  listAutomations,
} from "@/features/base/services/base-service";

type PropertyOptionsProps = {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  hideButtons?: boolean;
};

// Property types whose value an AI prompt can fill in.
const AI_FILL_TYPES = new Set(["text", "longText", "number", "select", "status", "multiSelect", "checkbox"]);

export function PropertyOptions(props: PropertyOptionsProps) {
  const inner = <PropertyOptionsByType {...props} />;
  if (!AI_FILL_TYPES.has(props.property.type)) return inner;
  return (
    <Stack gap="sm">
      {inner}
      <AiFillOptionsEditor property={props.property} onUpdate={props.onUpdate} />
    </Stack>
  );
}

function PropertyOptionsByType({ property, onUpdate, onClose, onDirtyChange, hideButtons }: PropertyOptionsProps) {
  const { t } = useTranslation();

  switch (property.type) {
    case "button":
      return <ButtonOptions property={property} onUpdate={onUpdate} />;
    case "select":
    case "multiSelect":
      return (
        <SelectOptions
          property={property}
          onUpdate={onUpdate}
          onClose={onClose}
          onDirtyChange={onDirtyChange}
          hideButtons={hideButtons}
        />
      );
    case "status":
      return (
        <StatusOptions
          property={property}
          onUpdate={onUpdate}
          onClose={onClose}
          onDirtyChange={onDirtyChange}
          hideButtons={hideButtons}
        />
      );
    case "number":
      return (
        <NumberOptions
          property={property}
          onUpdate={onUpdate}
        />
      );
    case "id":
      return <IdOptions property={property} onUpdate={onUpdate} />;
    case "relation":
      return <RelationOptions property={property} onUpdate={onUpdate} />;
    case "rollup":
      return <RollupOptions property={property} onUpdate={onUpdate} />;
    case "date":
      return (
        <DateOptions
          property={property}
          onUpdate={onUpdate}
        />
      );
    case "person":
      return (
        <PersonOptions
          property={property}
          onUpdate={onUpdate}
        />
      );
    default:
      return (
        <Text size="xs" c="dimmed">
          {t("No options for this property type")}
        </Text>
      );
  }
}

function SelectOptions({
  property,
  onUpdate,
  onClose,
  onDirtyChange,
  hideButtons,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  hideButtons?: boolean;
}) {
  const options = property.typeOptions as SelectTypeOptions | undefined;
  const choices = useMemo(() => options?.choices ?? [], [options?.choices]);

  const handleSave = useCallback(
    (newChoices: Choice[]) => {
      onUpdate({
        ...property.typeOptions,
        choices: newChoices,
        choiceOrder: newChoices.map((c) => c.id),
      });
    },
    [property.typeOptions, onUpdate],
  );

  return (
    <ChoiceEditor
      initialChoices={choices}
      onSave={handleSave}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      showCategories={false}
      hideButtons={hideButtons}
    />
  );
}

function StatusOptions({
  property,
  onUpdate,
  onClose,
  onDirtyChange,
  hideButtons,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  hideButtons?: boolean;
}) {
  const options = property.typeOptions as SelectTypeOptions | undefined;
  const choices = useMemo(() => options?.choices ?? [], [options?.choices]);

  const handleSave = useCallback(
    (newChoices: Choice[]) => {
      onUpdate({
        ...property.typeOptions,
        choices: newChoices,
        choiceOrder: newChoices.map((c) => c.id),
      });
    },
    [property.typeOptions, onUpdate],
  );

  return (
    <ChoiceEditor
      initialChoices={choices}
      onSave={handleSave}
      onClose={onClose}
      onDirtyChange={onDirtyChange}
      showCategories
      hideButtons={hideButtons}
    />
  );
}

function NumberOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as NumberTypeOptions | undefined;

  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label={t("Format")}
        allowDeselect={false}
        data={[
          { value: "plain", label: t("Number") },
          { value: "currency", label: t("Currency") },
          { value: "percent", label: t("Percent") },
          { value: "progress", label: t("Progress") },
        ]}
        value={options?.format ?? "plain"}
        onChange={(val) =>
          onUpdate({ ...property.typeOptions, format: val ?? "plain" })
        }
      />
      <NumberInput
        size="xs"
        label={t("Decimal places")}
        min={0}
        max={8}
        value={options?.precision ?? 0}
        onChange={(val) =>
          onUpdate({ ...property.typeOptions, precision: val })
        }
      />
    </Stack>
  );
}

// Relation: which base the rows come from, one or many.
function RelationOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as RelationTypeOptions | undefined;
  const { data: base } = useBaseQuery(property.pageId);
  const { data: bases } = useQuery({
    queryKey: ["bases", "list", base?.spaceId, "all"],
    queryFn: () => listBases(base!.spaceId, { limit: 100 }),
    enabled: !!base?.spaceId,
  });
  const data = (bases?.items ?? []).map((b) => ({ value: b.id, label: b.id === property.pageId ? `${b.name} (${t("this base")})` : b.name }));
  if (base && !data.some((d) => d.value === base.id)) {
    data.unshift({ value: base.id, label: `${base.name} (${t("this base")})` });
  }
  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label={t("Related base")}
        placeholder={t("Pick a base")}
        data={data}
        value={options?.targetPageId ?? null}
        onChange={(val) => val && onUpdate({ ...property.typeOptions, targetPageId: val })}
        searchable
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
        nothingFoundMessage={t("No bases in this space")}
      />
      <Switch
        size="xs"
        label={t("Allow several rows")}
        checked={options?.allowMultiple !== false}
        onChange={(e) => onUpdate({ ...property.typeOptions, allowMultiple: e.currentTarget.checked })}
      />
    </Stack>
  );
}

// Rollup: a relation of this base, a property of the related base, an aggregate.
function RollupOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as RollupTypeOptions | undefined;
  const { data: base } = useBaseQuery(property.pageId);
  const relations = (base?.properties ?? []).filter((p) => p.type === "relation");
  const relation = relations.find((p) => p.id === options?.relationPropertyId);
  const targetPageId = (relation?.typeOptions as RelationTypeOptions | undefined)?.targetPageId;
  const { data: targetBase } = useBaseQuery(targetPageId);
  const aggregate = options?.aggregate ?? "count";
  const numericOnly = ["sum", "avg", "min", "max"].includes(aggregate);
  const targetProps = (targetBase?.properties ?? []).filter((p) =>
    numericOnly ? ["number", "formula", "rollup", "id"].includes(p.type) : p.type !== "relation",
  );
  return (
    <Stack gap="xs">
      <Select
        size="xs"
        label={t("Relation")}
        placeholder={relations.length ? t("Pick a relation") : t("Add a relation property first")}
        data={relations.map((p) => ({ value: p.id, label: p.name || t("Untitled") }))}
        value={options?.relationPropertyId ?? null}
        onChange={(val) => val && onUpdate({ ...property.typeOptions, aggregate, relationPropertyId: val })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
      <Select
        size="xs"
        label={t("Calculate")}
        data={[
          { value: "count", label: t("Count") },
          { value: "sum", label: t("Sum") },
          { value: "avg", label: t("Average") },
          { value: "min", label: t("Min") },
          { value: "max", label: t("Max") },
          { value: "show", label: t("Show values") },
        ]}
        value={aggregate}
        onChange={(val) => val && onUpdate({ ...property.typeOptions, aggregate: val })}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
      {aggregate !== "count" && (
        <Select
          size="xs"
          label={t("Property of the related base")}
          placeholder={targetPageId ? t("Pick a property") : t("Pick a relation first")}
          data={targetProps.map((p) => ({ value: p.id, label: p.name || t("Untitled") }))}
          value={options?.targetPropertyId ?? null}
          onChange={(val) => val && onUpdate({ ...property.typeOptions, aggregate, targetPropertyId: val })}
          allowDeselect={false}
          disabled={!targetPageId}
          comboboxProps={{ withinPortal: true }}
        />
      )}
    </Stack>
  );
}

// ID: only the prefix shown in front of the row number.
function IdOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as IdTypeOptions | undefined;
  return (
    <Stack gap="xs">
      <TextInput
        size="xs"
        label={t("Prefix")}
        placeholder="INV-"
        maxLength={20}
        value={options?.prefix ?? ""}
        onChange={(e) =>
          onUpdate({ ...property.typeOptions, prefix: e.currentTarget.value })
        }
      />
      <Text size="xs" c="dimmed">
        {t("Numbers are assigned when a row is created and never reused.")}
      </Text>
    </Stack>
  );
}

function DateOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as DateTypeOptions | undefined;

  return (
    <Stack gap="xs">
      <Switch
        size="xs"
        label={t("Include time")}
        checked={options?.includeTime ?? false}
        onChange={(e) =>
          onUpdate({
            ...property.typeOptions,
            includeTime: e.currentTarget.checked,
          })
        }
      />
      {options?.includeTime && (
        <Select
          size="xs"
          label={t("Time format")}
          allowDeselect={false}
          data={[
            { value: "12h", label: "12-hour" },
            { value: "24h", label: "24-hour" },
          ]}
          value={options?.timeFormat ?? "12h"}
          onChange={(val) =>
            onUpdate({ ...property.typeOptions, timeFormat: val ?? "12h" })
          }
        />
      )}
    </Stack>
  );
}

function PersonOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = property.typeOptions as PersonTypeOptions | undefined;

  return (
    <Stack gap="xs">
      <Switch
        size="xs"
        label={t("Allow multiple people")}
        checked={options?.allowMultiple !== false}
        onChange={(e) =>
          onUpdate({
            ...property.typeOptions,
            allowMultiple: e.currentTarget.checked,
          })
        }
      />
    </Stack>
  );
}

function ButtonOptions({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const options = (property.typeOptions ?? {}) as ButtonTypeOptions;
  const { data } = useQuery({
    queryKey: ["base-automations", property.pageId],
    queryFn: () => listAutomations(property.pageId),
  });
  const automations = (data?.items ?? []).map((a) => ({ value: a.id, label: `${a.name}${a.trigger?.type === "button" ? "" : ` (${a.trigger?.type})`}` }));
  return (
    <Stack gap="xs">
      <TextInput
        size="xs"
        label={t("Button label")}
        placeholder={t("Run")}
        maxLength={60}
        value={options.label ?? ""}
        onChange={(e) => onUpdate({ ...property.typeOptions, label: e.currentTarget.value })}
      />
      <Select
        size="xs"
        label={t("Automation to run")}
        placeholder={automations.length ? t("Pick an automation") : t("No automations yet (toolbar: Automations)")}
        data={automations}
        value={options.automationId ?? null}
        onChange={(val) => onUpdate({ ...property.typeOptions, automationId: val ?? undefined })}
        clearable
        comboboxProps={{ withinPortal: true }}
      />
      <Text size="xs" c="dimmed">
        {t("Pressing the button runs the automation for that row.")}
      </Text>
    </Stack>
  );
}

// AI autofill: a prompt answered from the row's other cells.
function AiFillOptionsEditor({
  property,
  onUpdate,
}: {
  property: IBaseProperty;
  onUpdate: (typeOptions: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const ai = ((property.typeOptions ?? {}) as { ai?: AiFillOptions }).ai;
  const [prompt, setPrompt] = useState(ai?.prompt ?? "");
  const enabled = Boolean(ai?.prompt);
  const save = (patch: Partial<AiFillOptions> | null) => {
    const current = (property.typeOptions ?? {}) as Record<string, unknown>;
    if (patch === null) {
      const { ai: _drop, ...rest } = current;
      onUpdate(rest);
      return;
    }
    onUpdate({ ...current, ai: { ...(ai ?? { prompt: "" }), ...patch } });
  };
  return (
    <Stack gap={6} data-testid="ai-fill-options">
      <Switch
        size="xs"
        label={t("AI autofill")}
        checked={enabled}
        onChange={(e) => {
          if (e.currentTarget.checked) {
            const p = prompt.trim() || t("Summarize this row in one line");
            setPrompt(p);
            save({ prompt: p });
          } else save(null);
        }}
      />
      {enabled && (
        <>
          <Textarea
            size="xs"
            label={t("Prompt")}
            description={t("Runs over the row's other cells; the answer becomes this cell.")}
            autosize
            minRows={2}
            maxLength={2000}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            onBlur={() => prompt.trim() && prompt.trim() !== ai?.prompt && save({ prompt: prompt.trim() })}
          />
          <Switch
            size="xs"
            label={t("Refill when the row changes")}
            checked={Boolean(ai?.autoUpdate)}
            onChange={(e) => save({ autoUpdate: e.currentTarget.checked })}
          />
        </>
      )}
    </Stack>
  );
}
