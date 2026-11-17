import { ActionIcon, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { IVerifier } from "@/features/page-verification/types";

interface Props {
  verifiers: IVerifier[];
  onRemove?: (userId: string) => void;
  removable?: boolean;
}

export default function VerifierList({ verifiers, onRemove, removable }: Props) {
  const { t } = useTranslation();
  if (verifiers.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("No verifiers yet.")}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {verifiers.map((v) => (
        <Group key={v.id} justify="space-between" wrap="nowrap" py={4}>
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <CustomAvatar avatarUrl={v.avatarUrl ?? undefined} name={v.name} size={26} />
            <div style={{ minWidth: 0 }}>
              <Text size="sm" truncate="end">
                {v.name}
              </Text>
              {v.email && (
                <Text size="xs" c="dimmed" truncate="end">
                  {v.email}
                </Text>
              )}
            </div>
          </Group>
          {removable && onRemove && (
            <Tooltip label={t("Remove verifier")} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={() => onRemove(v.id)}
                aria-label={t("Remove verifier")}
              >
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ))}
    </Stack>
  );
}
