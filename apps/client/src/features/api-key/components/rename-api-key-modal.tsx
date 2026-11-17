import { useEffect } from "react";
import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { z } from "zod/v4";
import { useTranslation } from "react-i18next";
import { useRenameApiKeyMutation } from "@/features/api-key/queries/api-key-query.ts";
import { IApiKey } from "@/features/api-key/types/api-key.types.ts";

const formSchema = z.object({
  name: z.string().trim().min(1, { message: "Name is required" }).max(100),
});
type FormValues = z.infer<typeof formSchema>;

interface RenameApiKeyModalProps {
  apiKey: IApiKey | null;
  onClose: () => void;
}

export function RenameApiKeyModal({ apiKey, onClose }: RenameApiKeyModalProps) {
  const { t } = useTranslation();
  const renameMutation = useRenameApiKeyMutation();

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: { name: "" },
  });

  useEffect(() => {
    if (apiKey) {
      form.setValues({ name: apiKey.name });
      form.resetDirty({ name: apiKey.name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const handleSubmit = async (values: FormValues) => {
    if (!apiKey) return;
    try {
      await renameMutation.mutateAsync({ apiKeyId: apiKey.id, name: values.name });
      onClose();
    } catch {
      // the mutation already showed the error
    }
  };

  return (
    <Modal
      opened={!!apiKey}
      onClose={onClose}
      title={t("Rename API key")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack gap="md">
          <TextInput
            label={t("Name")}
            data-autofocus
            required
            {...form.getInputProps("name")}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={renameMutation.isPending}>
              {t("Save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
