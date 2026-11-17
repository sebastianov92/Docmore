import { Alert, Button, Code, Group, Paper, SimpleGrid, Text } from "@mantine/core";
import { IconAlertCircle, IconCheck, IconCopy, IconDownload } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/components/common/copy-button";

interface BackupCodesPanelProps {
  codes: string[];
  title?: string;
}

export function BackupCodesPanel({ codes, title }: BackupCodesPanelProps) {
  const { t } = useTranslation();

  const download = () => {
    const body = [
      t("Docmore backup codes"),
      t("Each code works once. Keep this file somewhere safe."),
      "",
      ...codes,
      "",
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "docmore-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Alert icon={<IconAlertCircle size={18} />} color="yellow" variant="light">
        <Text size="sm">
          {t("Save these codes now. Each one lets you in once if you lose your authenticator. They will not be shown again.")}
        </Text>
      </Alert>

      <Paper p="md" withBorder>
        <Group justify="space-between" mb="sm" wrap="nowrap">
          <Text size="sm" fw={600}>
            {title ?? t("Backup codes")}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <CopyButton value={codes.join("\n")}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={copy}
                  leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                >
                  {copied ? t("Copied") : t("Copy")}
                </Button>
              )}
            </CopyButton>
            <Button
              size="xs"
              variant="subtle"
              onClick={download}
              leftSection={<IconDownload size={14} />}
            >
              {t("Download")}
            </Button>
          </Group>
        </Group>

        <SimpleGrid cols={2} spacing="xs">
          {codes.map((code) => (
            <Code key={code} block ta="center" fz="sm" style={{ letterSpacing: "0.12em" }}>
              {code}
            </Code>
          ))}
        </SimpleGrid>
      </Paper>
    </>
  );
}
