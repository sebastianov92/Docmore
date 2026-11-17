import { useState } from "react";
import { Alert, Anchor, Box, Button, Container, Stack, Text, Title } from "@mantine/core";
import { IconCheck, IconShieldLock } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "@/features/auth/components/auth-layout.tsx";
import classes from "@/features/auth/components/auth.module.css";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route";
import { useMfaGate } from "@/features/mfa/hooks/use-mfa-gate.ts";
import { MfaSetupFlow } from "@/features/mfa/components/mfa-setup-flow.tsx";
import { BackupCodesPanel } from "@/features/mfa/components/backup-codes-panel.tsx";
import { IMfaEnabled } from "@/features/mfa/types/mfa.types.ts";

export default function MfaSetupRequiredPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { ready } = useMfaGate();
  const [result, setResult] = useState<IMfaEnabled | null>(null);

  if (!ready) {
    return null;
  }

  const finish = () => {
    // The server opened the session when the code was verified.
    navigate(result?.loggedIn ? getPostLoginRedirect() : APP_ROUTE.AUTH.LOGIN);
  };

  return (
    <AuthLayout>
      <Container size={480} className={classes.container}>
        <Box p="xl" className={classes.containerBox}>
          <Title order={1} size="h2" ta="center" fw={500} mb="xs">
            {t("Set up two-factor authentication")}
          </Title>

          {!result ? (
            <Stack gap="md">
              <Alert icon={<IconShieldLock size={18} />} color="blue" variant="light">
                <Text size="sm">
                  {t("This workspace requires two-factor authentication. Set it up once to continue.")}
                </Text>
              </Alert>

              <MfaSetupFlow active={ready} onEnabled={setResult} />

              <Anchor
                component="button"
                type="button"
                size="sm"
                c="dimmed"
                ta="center"
                onClick={() => navigate(APP_ROUTE.AUTH.LOGIN)}
              >
                {t("Back to login")}
              </Anchor>
            </Stack>
          ) : (
            <Stack gap="md">
              <BackupCodesPanel codes={result.backupCodes} />
              <Button fullWidth onClick={finish} leftSection={<IconCheck size={18} />}>
                {t("I've saved my backup codes")}
              </Button>
            </Stack>
          )}
        </Box>
      </Container>
    </AuthLayout>
  );
}
