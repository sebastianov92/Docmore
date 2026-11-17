import { Button, Group, Modal, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { z } from "zod/v4";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useCreatePersonalSpaceMutation } from "@/features/personal-space/queries/personal-space-query";
import { getApiErrorMessage } from "@/lib/api-error";
import { getSpaceUrl } from "@/lib/config.ts";

const schema = z.object({
  name: z.string().trim().min(2).max(100),
});
type FormValues = z.infer<typeof schema>;

interface Props {
  opened: boolean;
  onClose: () => void;
}

// Suggests "<first name>'s space" and jumps into the new space once made.
export default function CreatePersonalSpaceModal({ opened, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentUser = useAtomValue(currentUserAtom);
  const createMutation = useCreatePersonalSpaceMutation();

  const firstName = (currentUser?.user?.name ?? "").trim().split(/\s+/)[0];
  const form = useForm<FormValues>({
    validate: zod4Resolver(schema),
    initialValues: {
      name: firstName
        ? t("{{name}}'s space", { name: firstName })
        : t("Personal space"),
    },
  });

  const handleSubmit = async (values: FormValues) => {
    try {
      const space = await createMutation.mutateAsync({ name: values.name });
      onClose();
      navigate(getSpaceUrl(space.slug));
    } catch (err) {
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to create personal space")),
        color: "red",
      });
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("Create personal space")}
      centered
    >
      <Text size="sm" c="dimmed" mb="md">
        {t("A space of your own. You decide later who else may join it.")}
      </Text>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <TextInput
          withAsterisk
          data-autofocus
          label={t("Space name")}
          variant="filled"
          {...form.getInputProps("name")}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="submit" loading={createMutation.isPending}>
            {t("Create")}
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
