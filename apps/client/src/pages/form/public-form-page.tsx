import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Checkbox, Container, Loader, MultiSelect, NumberInput, Paper, Select, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { AuthLayout } from "@/features/auth/components/auth-layout";
import { getPublicForm, submitPublicForm } from "@/features/base/services/base-service";
import { IPublicFormField } from "@/features/base/types/base.types";
import { getApiErrorMessage } from "@/lib/api-error";

// A base's public form: fields from its properties, one submission = one row.
export default function PublicFormPage() {
  const { token = "" } = useParams();
  const { t } = useTranslation();
  const { data: form, isLoading, isError } = useQuery({ queryKey: ["public-form", token], queryFn: () => getPublicForm(token), enabled: Boolean(token), retry: false });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () => submitPublicForm({ token, cells: values, website }),
    onSuccess: (r) => setDone(r.thanksText || t("Thanks, we got it.")),
    onError: (err) => setErrors({ _form: getApiErrorMessage(err) }),
  });

  const missing = useMemo(() => {
    if (!form) return [];
    return form.fields.filter((f) => f.required && isEmpty(values[f.propertyId])).map((f) => f.propertyId);
  }, [form, values]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (missing.length) {
      setErrors(Object.fromEntries(missing.map((id) => [id, t("Required")])));
      return;
    }
    setErrors({});
    submit.mutate();
  };

  return (
    <AuthLayout>
      <DocumentTitle title={form?.name ?? t("Form")} />
      <Container size={560} py={24}>
        {isLoading && <Loader size="sm" />}
        {isError && (
          <Text c="dimmed" ta="center">
            {t("This form is not available.")}
          </Text>
        )}
        {form && done && (
          <Paper withBorder p="lg" radius="md" data-testid="form-thanks">
            <Title order={3} mb="xs">
              {form.name}
            </Title>
            <Text>{done}</Text>
            <Button mt="md" variant="light" size="xs" onClick={() => { setDone(null); setValues({}); }}>
              {t("Send another")}
            </Button>
          </Paper>
        )}
        {form && !done && (
          <Paper withBorder p="lg" radius="md" component="form" onSubmit={onSubmit} data-testid="public-form">
            <Title order={3} mb={4}>
              {form.name}
            </Title>
            {form.description && (
              <Text size="sm" c="dimmed" mb="md">
                {form.description}
              </Text>
            )}
            <Stack gap="sm">
              {form.fields.map((f) => (
                <FieldInput key={f.propertyId} field={f} value={values[f.propertyId]} error={errors[f.propertyId]} onChange={(v) => setValues((prev) => ({ ...prev, [f.propertyId]: v }))} />
              ))}
              {/* honeypot: hidden from people, filled by bots */}
              <TextInput name="website" value={website} onChange={(e) => setWebsite(e.currentTarget.value)} tabIndex={-1} autoComplete="off" style={{ position: "absolute", left: -10000, top: 0, width: 1, height: 1, opacity: 0 }} aria-hidden="true" />
              {errors._form && (
                <Text size="sm" c="red">
                  {errors._form}
                </Text>
              )}
              <Button type="submit" loading={submit.isPending} data-testid="form-submit">
                {form.submitLabel || t("Send")}
              </Button>
            </Stack>
          </Paper>
        )}
      </Container>
    </AuthLayout>
  );
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function FieldInput({ field, value, error, onChange }: { field: IPublicFormField; value: unknown; error?: string; onChange: (v: unknown) => void }) {
  const label = field.name;
  const common = { label, description: field.help ?? undefined, required: field.required, error, withAsterisk: field.required };
  const choices = useMemo(() => {
    const all = field.typeOptions.choices ?? [];
    const order = field.typeOptions.choiceOrder ?? [];
    const sorted = [...all].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    return sorted.map((c) => ({ value: c.id, label: c.name }));
  }, [field.typeOptions]);
  switch (field.type) {
    case "longText":
      return <Textarea {...common} autosize minRows={3} value={(value as string) ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />;
    case "number":
      return <NumberInput {...common} value={(value as number | string) ?? ""} onChange={(v) => onChange(v === "" ? null : v)} />;
    case "select":
    case "status":
      return <Select {...common} data={choices} value={(value as string) ?? null} onChange={(v) => onChange(v)} searchable clearable comboboxProps={{ withinPortal: true }} />;
    case "multiSelect":
      return <MultiSelect {...common} data={choices} value={(value as string[]) ?? []} onChange={(v) => onChange(v)} searchable clearable comboboxProps={{ withinPortal: true }} />;
    case "date":
      return <DateInput {...common} value={value ? new Date(value as string) : null} onChange={(d) => onChange(d ? new Date(d as unknown as string).toISOString() : null)} clearable popoverProps={{ withinPortal: true }} />;
    case "checkbox":
      return <Checkbox label={label} description={field.help ?? undefined} checked={Boolean(value)} onChange={(e) => onChange(e.currentTarget.checked)} error={error} />;
    case "email":
      return <TextInput {...common} type="email" value={(value as string) ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />;
    case "url":
      return <TextInput {...common} type="url" placeholder="https://" value={(value as string) ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />;
    case "location":
      return (
        <TextInput
          {...common}
          placeholder="Place | address @ lat, lng"
          value={typeof value === "string" ? value : value && typeof value === "object" ? String((value as { name?: string }).name ?? "") : ""}
          onChange={(e) => onChange(e.currentTarget.value || null)}
        />
      );
    default:
      return <TextInput {...common} value={(value as string) ?? ""} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}
