import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Container,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { unlockShare } from "@/features/share/services/share-service.ts";
import { setShareAccessToken } from "@/features/share/share-access.ts";
import { DocumentTitle } from "@/components/ui/document-title.tsx";

interface Props {
  shareId: string;
}

// Shown in place of a shared page whose link asks for a password. The right
// password yields a token; every share request then carries it.
export default function SharePasswordGate({ shareId }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await unlockShare(shareId, password);
      if (token) setShareAccessToken(shareId, token);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["shares"] }),
        queryClient.invalidateQueries({ queryKey: ["shared-page-tree"] }),
        queryClient.invalidateQueries({ queryKey: ["bases"] }),
        queryClient.invalidateQueries({ queryKey: ["base-rows"] }),
      ]);
    } catch (err: any) {
      const reason = err?.response?.data?.reason;
      setError(
        reason === "wrong_password"
          ? t("Wrong password")
          : err?.response?.data?.message || t("Something went wrong"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DocumentTitle title={t("Password required")} withAppName={false} />
      <Container size={420} py={80}>
        <form onSubmit={submit}>
          <Stack gap="sm" align="center">
            <IconLock size={28} stroke={1.5} />
            <Title order={3} ta="center">
              {t("This page is password protected")}
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              {t("Enter the password to continue")}
            </Text>
            <PasswordInput
              w="100%"
              mt="xs"
              placeholder={t("Password")}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              error={error}
              autoFocus
              data-autofocus
            />
            <Group justify="center" w="100%">
              <Button type="submit" loading={busy} disabled={!password} fullWidth>
                {t("Unlock")}
              </Button>
            </Group>
          </Stack>
        </form>
      </Container>
    </>
  );
}
