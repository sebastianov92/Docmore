import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import CopyTextButton from "@/components/common/copy.tsx";
import { IApiKey } from "@/features/api-key/types/api-key.types.ts";

interface ApiKeyCreatedModalProps {
  apiKey: IApiKey | null;
  onClose: () => void;
}

export function ApiKeyCreatedModal({ apiKey, onClose }: ApiKeyCreatedModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      opened={!!apiKey}
      onClose={onClose}
      title={t("API key created")}
      size="lg"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      {apiKey && (
        <Stack gap="md">
          <Alert
            icon={<IconAlertTriangle size={16} />}
            title={t("Copy it now")}
            color="yellow"
            variant="light"
          >
            {t("This is the only time the key is shown. If you lose it, revoke it and create a new one.")}
          </Alert>

          <div>
            <Text size="sm" fw={500} mb={4}>
              {apiKey.name}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput
                variant="filled"
                style={{ flex: 1 }}
                value={apiKey.token ?? ""}
                readOnly
                styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyTextButton text={apiKey.token ?? ""} label={t("Copy API key")} />
            </Group>
          </div>

          <Text size="sm" c="dimmed">
            {t("Send it as a bearer token:")}{" "}
            <Text span ff="monospace" size="sm">
              Authorization: Bearer &lt;key&gt;
            </Text>
          </Text>

          <Button fullWidth onClick={onClose}>
            {t("I've saved it")}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
