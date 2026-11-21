import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { IconCloudOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { probeServer, setWorkOffline, useConnectivity } from "@/lib/offline/connectivity.ts";

// The app was opened with no server and this device holds nothing of the
// account yet: there is nothing to show until it connects once.
export function OfflineNoData() {
  const { t } = useTranslation();
  const { workOffline } = useConnectivity();

  const retry = async () => {
    if (workOffline) setWorkOffline(false);
    if (await probeServer()) window.location.reload();
  };

  return (
    <Center mih="100vh" p="xl">
      <Stack align="center" gap="sm" maw={420}>
        <IconCloudOff size={40} stroke={1.5} />
        <Title order={3} ta="center">
          {t("The server cannot be reached")}
        </Title>
        <Text c="dimmed" ta="center" size="sm">
          {t(
            "Nothing from your account is saved on this device yet. Connect once and the pages you choose will also open offline.",
          )}
        </Text>
        <Button variant="default" onClick={retry} mt="xs">
          {t("Retry now")}
        </Button>
      </Stack>
    </Center>
  );
}
