import { lazy, Suspense, useState } from "react";
import {
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconCalendar } from "@tabler/icons-react";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { addDays, addYears, subDays } from "date-fns";
import { useTranslation } from "react-i18next";
import { useCreateApiKeyMutation } from "@/features/api-key/queries/api-key-query.ts";
import { ApiKeyScope, IApiKey } from "@/features/api-key/types/api-key.types.ts";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale.ts";

const DateInput = lazy(() =>
  import("@mantine/dates").then((module) => ({ default: module.DateInput })),
);

const MAX_LIFETIME_YEARS = 3;
const CUSTOM = "custom";

type Access = "read-write" | "read-only";

const scopesFor: Record<Access, ApiKeyScope[]> = {
  "read-write": ["read", "write"],
  "read-only": ["read"],
};

const formSchema = z.object({
  name: z.string().trim().min(1, { message: "Name is required" }).max(100),
});
type FormValues = z.infer<typeof formSchema>;

interface CreateApiKeyModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (apiKey: IApiKey) => void;
}

export function CreateApiKeyModal({
  opened,
  onClose,
  onCreated,
}: CreateApiKeyModalProps) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const [access, setAccess] = useState<Access>("read-write");
  const [lifetime, setLifetime] = useState<string>("90");
  const [customDate, setCustomDate] = useState<Date | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const createMutation = useCreateApiKeyMutation();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: { name: "" },
  });

  const lifetimeOptions = [30, 60, 90, 365].map((days) => ({
    value: String(days),
    label: `${days === 365 ? t("1 year") : t("{{count}} days", { count: days })} · ${formatLocalized(addDays(new Date(), days), "MMM dd, yyyy", "PP", locale)}`,
  }));
  lifetimeOptions.push({ value: CUSTOM, label: t("Custom date") });

  const resolveExpiry = (): Date | null => {
    if (lifetime === CUSTOM) {
      return customDate;
    }
    return addDays(new Date(), parseInt(lifetime, 10));
  };

  const reset = () => {
    form.reset();
    setAccess("read-write");
    setLifetime("90");
    setCustomDate(null);
    setCustomError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (values: FormValues) => {
    const expiresAt = resolveExpiry();
    if (!expiresAt) {
      setCustomError(t("Pick an expiration date"));
      return;
    }
    // Let a picked day last until its end, not until midnight at its start.
    const endOfDay = new Date(expiresAt);
    if (lifetime === CUSTOM) {
      endOfDay.setHours(23, 59, 59, 0);
    }

    try {
      const created = await createMutation.mutateAsync({
        name: values.name,
        expiresAt: endOfDay.toISOString(),
        scopes: scopesFor[access],
      });
      reset();
      onCreated(created);
    } catch {
      // the mutation already showed the error
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Create API key")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t("Name")}
            description={t("What will use this key, so you recognise it later.")}
            placeholder={t("e.g. n8n automation")}
            data-autofocus
            required
            {...form.getInputProps("name")}
          />

          <div>
            <Text size="sm" fw={500} mb={4}>
              {t("Permissions")}
            </Text>
            <SegmentedControl
              fullWidth
              value={access}
              onChange={(value) => setAccess(value as Access)}
              data={[
                { value: "read-write", label: t("Read and write") },
                { value: "read-only", label: t("Read-only") },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              {access === "read-write"
                ? t("Can view, create and change anything you can.")
                : t("Can only view what you can see. Nothing gets created or changed.")}
            </Text>
          </div>

          <Select
            label={t("Expiration")}
            data={lifetimeOptions}
            value={lifetime}
            onChange={(value) => {
              setLifetime(value ?? "90");
              setCustomError(null);
            }}
            leftSection={<IconCalendar size={16} />}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />

          {lifetime === CUSTOM && (
            <Suspense fallback={null}>
              <DateInput
                label={t("Expires on")}
                description={t("Up to {{years}} years from today", {
                  years: MAX_LIFETIME_YEARS,
                })}
                placeholder={t("Pick a date")}
                value={customDate}
                onChange={(value) => {
                  setCustomDate(value ? new Date(value) : null);
                  setCustomError(null);
                }}
                minDate={addDays(new Date(), 1)}
                maxDate={subDays(addYears(new Date(), MAX_LIFETIME_YEARS), 1)}
                error={customError}
                popoverProps={{ withinPortal: true }}
              />
            </Suspense>
          )}

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={handleClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={createMutation.isPending}>
              {t("Create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
