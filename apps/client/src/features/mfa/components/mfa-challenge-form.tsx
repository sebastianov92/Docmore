import { useState } from "react";
import {
  Anchor,
  Box,
  Button,
  Center,
  Container,
  PinInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "@/features/auth/components/auth-layout.tsx";
import classes from "@/features/auth/components/auth.module.css";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route";
import { verifyMfa } from "@/features/mfa/services/mfa-service.ts";

export function MfaChallengeForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const value = code.trim();
    if (!value || loading) return;
    setLoading(true);
    try {
      await verifyMfa(value);
      navigate(getPostLoginRedirect());
    } catch (error: any) {
      setLoading(false);
      setCode("");
      notifications.show({
        message: error?.response?.data?.message || t("Invalid verification code"),
        color: "red",
      });
    }
  };

  const switchMode = () => {
    setUseBackup((value) => !value);
    setCode("");
  };

  return (
    <AuthLayout>
      <Container size={420} className={classes.container}>
        <Box p="xl" className={classes.containerBox}>
          <Title order={1} size="h2" ta="center" fw={500} mb="xs">
            {t("Two-factor authentication")}
          </Title>
          <Text size="sm" c="dimmed" ta="center" mb="xl">
            {useBackup
              ? t("Enter one of your backup codes. Each one works once.")
              : t("Enter the 6-digit code from your authenticator app.")}
          </Text>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Stack gap="lg">
              {useBackup ? (
                <TextInput
                  label={t("Backup code")}
                  placeholder="XXXXXXXX"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value.toUpperCase())}
                  maxLength={9}
                  autoFocus
                  styles={{ input: { fontFamily: "monospace", letterSpacing: "0.12em" } }}
                />
              ) : (
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
              )}

              <Button type="submit" fullWidth loading={loading} disabled={!code}>
                {t("Verify")}
              </Button>

              <Stack gap={4} align="center">
                <Anchor component="button" type="button" size="sm" onClick={switchMode}>
                  {useBackup ? t("Use the authenticator app instead") : t("Use a backup code")}
                </Anchor>
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  c="dimmed"
                  onClick={() => navigate(APP_ROUTE.AUTH.LOGIN)}
                >
                  {t("Back to login")}
                </Anchor>
              </Stack>
            </Stack>
          </form>
        </Box>
      </Container>
    </AuthLayout>
  );
}
