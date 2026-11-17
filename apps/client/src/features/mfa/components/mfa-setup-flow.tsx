import { useEffect, useState } from "react";
import {
  Button,
  Center,
  Code,
  Collapse,
  Group,
  Image,
  Loader,
  Paper,
  PinInput,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconShieldCheck } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import CopyTextButton from "@/components/common/copy.tsx";
import { enableMfa, setupMfa } from "@/features/mfa/services/mfa-service.ts";
import { IMfaEnabled, IMfaSetup } from "@/features/mfa/types/mfa.types.ts";

interface MfaSetupFlowProps {
  // Starts a fresh secret every time it becomes true.
  active: boolean;
  onEnabled: (result: IMfaEnabled) => void;
}

// Step one of enabling 2FA: show the QR code, confirm one code from the app.
export function MfaSetupFlow({ active, onEnabled }: MfaSetupFlowProps) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<IMfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [showManual, setShowManual] = useState(false);

  const setupMutation = useMutation({
    mutationFn: setupMfa,
    onSuccess: setSetup,
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message || t("Could not start the setup"),
        color: "red",
      });
    },
  });

  const enableMutation = useMutation({
    mutationFn: enableMfa,
    onSuccess: onEnabled,
    onError: (error: any) => {
      notifications.show({
        message: error?.response?.data?.message || t("Invalid verification code"),
        color: "red",
      });
      setCode("");
    },
  });

  useEffect(() => {
    if (active) {
      setSetup(null);
      setCode("");
      setShowManual(false);
      setupMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const submit = () => {
    if (code.length === 6) {
      enableMutation.mutate(code);
    }
  };

  if (setupMutation.isPending || (!setup && !setupMutation.isError)) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (!setup) {
    return (
      <Stack align="center" py="md" gap="sm">
        <Text size="sm" c="dimmed">
          {t("Could not generate the QR code.")}
        </Text>
        <Button variant="default" onClick={() => setupMutation.mutate()}>
          {t("Try again")}
        </Button>
      </Stack>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack gap="md">
        <Text size="sm">
          {t("1. Scan this code with an authenticator app such as Aegis, 1Password, Google Authenticator or Authy.")}
        </Text>

        <Center>
          <Paper p="sm" withBorder>
            <Image src={setup.qrCode} alt={t("Two-factor QR code")} w={200} h={200} />
          </Paper>
        </Center>

        <UnstyledButton onClick={() => setShowManual((value) => !value)}>
          <Group gap={6}>
            {showManual ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            <Text size="sm" c="dimmed">
              {t("Can't scan it? Type the key instead")}
            </Text>
          </Group>
        </UnstyledButton>

        <Collapse expanded={showManual}>
          <Group gap="xs" wrap="nowrap" align="center">
            <Code block style={{ flex: 1, letterSpacing: "0.08em", wordBreak: "break-all" }}>
              {setup.manualKey}
            </Code>
            <CopyTextButton text={setup.manualKey} label={t("Copy key")} />
          </Group>
        </Collapse>

        <Text size="sm">{t("2. Enter the 6-digit code the app shows.")}</Text>

        <Center>
          <PinInput
            length={6}
            type="number"
            oneTimeCode
            autoFocus
            value={code}
            onChange={setCode}
            onComplete={() => submit()}
            aria-label={t("Verification code")}
          />
        </Center>

        <Button
          type="submit"
          fullWidth
          disabled={code.length !== 6}
          loading={enableMutation.isPending}
          leftSection={<IconShieldCheck size={18} />}
        >
          {t("Verify and enable")}
        </Button>
      </Stack>
    </form>
  );
}
