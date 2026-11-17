import { Alert, Button, Modal, PasswordInput, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { disableMfa } from "@/features/mfa/services/mfa-service.ts";

interface MfaDisableModalProps {
  opened: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function MfaDisableModal({ opened, onClose, onComplete }: MfaDisableModalProps) {
  const { t } = useTranslation();
  const { data: currentUser } = useCurrentUser();
  // SSO accounts have no password of their own to confirm with.
  const needsPassword = !currentUser?.user?.hasGeneratedPassword;

  const form = useForm({
    initialValues: { confirmPassword: "" },
    validate: {
      confirmPassword: (value) =>
        needsPassword && !value ? t("Password is required") : null,
    },
  });

  const disableMutation = useMutation({
    mutationFn: (values: { confirmPassword: string }) =>
      disableMfa(needsPassword ? values.confirmPassword : undefined),
    onSuccess: () => {
      form.reset();
      onComplete();
    },
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message || t("Could not disable two-factor authentication"),
        color: "red",
      });
    },
  });

  const handleClose = () => {
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Disable two-factor authentication")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form onSubmit={form.onSubmit((values) => disableMutation.mutate(values))}>
        <Stack gap="md">
          <Alert icon={<IconAlertTriangle size={18} />} color="red" variant="light">
            <Text size="sm">
              {t("Your password alone will be enough to sign in again. Your backup codes stop working.")}
            </Text>
          </Alert>

          {needsPassword && (
            <PasswordInput
              label={t("Confirm your password")}
              placeholder={t("Enter your password")}
              data-autofocus
              visibilityToggleButtonProps={{ "aria-label": t("Toggle password visibility") }}
              {...form.getInputProps("confirmPassword")}
            />
          )}

          <Stack gap="xs">
            <Button type="submit" color="red" fullWidth loading={disableMutation.isPending}>
              {t("Disable two-factor authentication")}
            </Button>
            <Button variant="default" fullWidth onClick={handleClose}>
              {t("Cancel")}
            </Button>
          </Stack>
        </Stack>
      </form>
    </Modal>
  );
}
