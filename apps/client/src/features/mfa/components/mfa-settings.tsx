import { useState } from "react";
import { Badge, Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";
import { useInvalidateMfaStatus, useMfaStatusQuery } from "@/features/mfa/queries/mfa-query.ts";
import { MfaSetupModal } from "./mfa-setup-modal.tsx";
import { MfaDisableModal } from "./mfa-disable-modal.tsx";
import { MfaBackupCodesModal } from "./mfa-backup-codes-modal.tsx";

export function MfaSettings() {
  const { t } = useTranslation();
  const { data: status, isLoading } = useMfaStatusQuery();
  const invalidateStatus = useInvalidateMfaStatus();
  const [setupOpened, setSetupOpened] = useState(false);
  const [disableOpened, setDisableOpened] = useState(false);
  const [codesOpened, setCodesOpened] = useState(false);

  if (isLoading || !status) {
    return null;
  }

  const enabled = status.isEnabled;

  return (
    <>
      <ResponsiveSettingsRow>
        <ResponsiveSettingsContent>
          <Group gap="xs">
            <Text size="md">{t("Two-factor authentication")}</Text>
            {enabled && (
              <Badge color="green" variant="light" radius="sm">
                {t("On")}
              </Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {enabled
              ? t("Signing in asks for a code from your authenticator app.")
              : t("Add a second step to sign in: a code from an authenticator app on your phone.")}
          </Text>
        </ResponsiveSettingsContent>

        <ResponsiveSettingsControl>
          {enabled ? (
            <Group gap="sm" wrap="nowrap">
              <Button variant="default" size="sm" onClick={() => setCodesOpened(true)} style={{ whiteSpace: "nowrap" }}>
                {t("Backup codes")} ({status.backupCodesCount})
              </Button>
              <Button variant="default" size="sm" c="red" onClick={() => setDisableOpened(true)} style={{ whiteSpace: "nowrap" }}>
                {t("Turn off")}
              </Button>
            </Group>
          ) : (
            <Button variant="default" onClick={() => setSetupOpened(true)} style={{ whiteSpace: "nowrap" }}>
              {t("Turn on")}
            </Button>
          )}
        </ResponsiveSettingsControl>
      </ResponsiveSettingsRow>

      <MfaSetupModal
        opened={setupOpened}
        onClose={() => setSetupOpened(false)}
        onComplete={() => {
          setSetupOpened(false);
          invalidateStatus();
          notifications.show({ message: t("Two-factor authentication is on") });
        }}
      />

      <MfaDisableModal
        opened={disableOpened}
        onClose={() => setDisableOpened(false)}
        onComplete={() => {
          setDisableOpened(false);
          invalidateStatus();
          notifications.show({ message: t("Two-factor authentication is off") });
        }}
      />

      <MfaBackupCodesModal
        opened={codesOpened}
        remaining={status.backupCodesCount}
        onClose={() => setCodesOpened(false)}
      />
    </>
  );
}
