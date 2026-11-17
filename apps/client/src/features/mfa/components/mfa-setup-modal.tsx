import { useState } from "react";
import { Button, Modal, Stack, Stepper } from "@mantine/core";
import { IconCheck, IconKey, IconQrcode } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { MfaSetupFlow } from "./mfa-setup-flow.tsx";
import { BackupCodesPanel } from "./backup-codes-panel.tsx";

interface MfaSetupModalProps {
  opened: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function MfaSetupModal({ opened, onClose, onComplete }: MfaSetupModalProps) {
  const { t } = useTranslation();
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const finish = () => {
    setBackupCodes(null);
    onComplete();
  };

  const handleClose = () => {
    // Closing after the codes were issued still counts as done: 2FA is on.
    if (backupCodes) {
      finish();
      return;
    }
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Set up two-factor authentication")}
      size="md"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <Stepper active={backupCodes ? 1 : 0} size="sm" mb="md">
        <Stepper.Step
          label={t("Authenticator")}
          description={t("Scan and verify")}
          icon={<IconQrcode size={18} />}
        />
        <Stepper.Step
          label={t("Backup codes")}
          description={t("Save them")}
          icon={<IconKey size={18} />}
        />
      </Stepper>

      {!backupCodes ? (
        <MfaSetupFlow
          active={opened}
          onEnabled={(result) => setBackupCodes(result.backupCodes)}
        />
      ) : (
        <Stack gap="md">
          <BackupCodesPanel codes={backupCodes} />
          <Button fullWidth onClick={finish} leftSection={<IconCheck size={18} />}>
            {t("I've saved my backup codes")}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
