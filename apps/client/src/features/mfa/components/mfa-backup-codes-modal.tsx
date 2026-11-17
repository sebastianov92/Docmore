import { useState } from "react";
import { Button, Modal, PasswordInput, Stack, Text } from "@mantine/core";
import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { regenerateBackupCodes } from "@/features/mfa/services/mfa-service.ts";
import { useInvalidateMfaStatus } from "@/features/mfa/queries/mfa-query.ts";
import { BackupCodesPanel } from "./backup-codes-panel.tsx";

interface MfaBackupCodesModalProps {
  opened: boolean;
  remaining: number;
  onClose: () => void;
}

export function MfaBackupCodesModal({ opened, remaining, onClose }: MfaBackupCodesModalProps) {
  const { t } = useTranslation();
  const { data: currentUser } = useCurrentUser();
  const invalidateStatus = useInvalidateMfaStatus();
  const [codes, setCodes] = useState<string[] | null>(null);
  const needsPassword = !currentUser?.user?.hasGeneratedPassword;

  const form = useForm({
    initialValues: { confirmPassword: "" },
    validate: {
      confirmPassword: (value) =>
        needsPassword && !value ? t("Password is required") : null,
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: (values: { confirmPassword: string }) =>
      regenerateBackupCodes(needsPassword ? values.confirmPassword : undefined),
    onSuccess: (data) => {
      setCodes(data.backupCodes);
      form.reset();
      invalidateStatus();
    },
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message || t("Could not generate new backup codes"),
        color: "red",
      });
    },
  });

  const handleClose = () => {
    setCodes(null);
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Backup codes")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      {codes ? (
        <Stack gap="md">
          <BackupCodesPanel codes={codes} title={t("Your new backup codes")} />
          <Button fullWidth onClick={handleClose} leftSection={<IconCheck size={18} />}>
            {t("I've saved my backup codes")}
          </Button>
        </Stack>
      ) : (
        <form onSubmit={form.onSubmit((values) => regenerateMutation.mutate(values))}>
          <Stack gap="md">
            <Text size="sm">
              {t("You have {{count}} unused backup codes. Generating new ones replaces them all; the old codes stop working.", {
                count: remaining,
              })}
            </Text>

            {needsPassword && (
              <PasswordInput
                label={t("Confirm your password")}
                placeholder={t("Enter your password")}
                data-autofocus
                visibilityToggleButtonProps={{ "aria-label": t("Toggle password visibility") }}
                {...form.getInputProps("confirmPassword")}
              />
            )}

            <Button
              type="submit"
              fullWidth
              loading={regenerateMutation.isPending}
              leftSection={<IconRefresh size={18} />}
            >
              {t("Generate new backup codes")}
            </Button>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
