import { useTranslation } from "react-i18next";
import { Group, Select, TextInput } from "@mantine/core";
import { FormCondition, FormField, IBaseProperty } from "@/features/base/types/base.types";

const ALWAYS = "__always";

type Props = {
  field: FormField;
  fields: FormField[];
  properties: IBaseProperty[];
  onChange: (showIf: FormCondition | null) => void;
};

// "Show this field when <other field> <is / is not / has any / ...> <value>".
export function FormConditionEditor({ field, fields, properties, onChange }: Props) {
  const { t } = useTranslation();
  const others = fields.filter((f) => f.propertyId !== field.propertyId).map((f) => properties.find((p) => p.id === f.propertyId)).filter((p): p is IBaseProperty => Boolean(p));
  const cond = field.showIf ?? null;
  const target = cond ? properties.find((p) => p.id === cond.propertyId) : undefined;
  const choices = ((target?.typeOptions as any)?.choices ?? []) as { id: string; name: string }[];
  const isChoice = target && (target.type === "select" || target.type === "status" || target.type === "multiSelect");
  const ops =
    target?.type === "checkbox"
      ? [{ value: "eq", label: t("is") }]
      : isChoice
        ? [
            { value: "eq", label: t("is") },
            { value: "neq", label: t("is not") },
            { value: "any", label: t("is any of") },
            { value: "isEmpty", label: t("is empty") },
            { value: "isNotEmpty", label: t("is not empty") },
          ]
        : [
            { value: "eq", label: t("is") },
            { value: "neq", label: t("is not") },
            { value: "contains", label: t("contains") },
            { value: "isEmpty", label: t("is empty") },
            { value: "isNotEmpty", label: t("is not empty") },
          ];
  const needsValue = cond && cond.op !== "isEmpty" && cond.op !== "isNotEmpty";
  return (
    <Group gap={6} wrap="wrap" data-testid="form-condition">
      <Select
        size="xs"
        w={150}
        data={[{ value: ALWAYS, label: t("Always shown") }, ...others.map((p) => ({ value: p.id, label: t("when {{name}}", { name: p.name }) }))]}
        value={cond?.propertyId ?? ALWAYS}
        onChange={(v) => onChange(!v || v === ALWAYS ? null : { propertyId: v, op: "eq", value: undefined })}
        allowDeselect={false}
        aria-label={t("Show when")}
      />
      {cond && <Select size="xs" w={120} data={ops} value={cond.op} onChange={(v) => v && onChange({ ...cond, op: v as FormCondition["op"] })} allowDeselect={false} aria-label={t("Condition")} />}
      {needsValue &&
        (target?.type === "checkbox" ? (
          <Select size="xs" w={100} data={[{ value: "true", label: t("checked") }, { value: "false", label: t("unchecked") }]} value={String(cond.value ?? "true")} onChange={(v) => onChange({ ...cond, value: v === "true" })} allowDeselect={false} />
        ) : isChoice ? (
          <Select size="xs" w={150} data={choices.map((c) => ({ value: c.id, label: c.name }))} value={typeof cond.value === "string" ? cond.value : null} onChange={(v) => onChange({ ...cond, value: v ?? undefined })} searchable aria-label={t("Value")} />
        ) : (
          <TextInput size="xs" w={150} value={typeof cond.value === "string" ? cond.value : ""} onChange={(e) => onChange({ ...cond, value: e.currentTarget.value })} placeholder={t("Value")} />
        ))}
    </Group>
  );
}
