import { Badge, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ApiKeyScope } from "@/features/api-key/types/api-key.types.ts";

export function ApiKeyScopeBadges({ scopes }: { scopes: ApiKeyScope[] }) {
  const { t } = useTranslation();
  const canWrite = scopes.includes("write");

  return (
    <Group gap={6} wrap="nowrap">
      <Badge variant="light" color="gray" radius="sm">
        {t("Read")}
      </Badge>
      {canWrite && (
        <Badge variant="light" color="blue" radius="sm">
          {t("Write")}
        </Badge>
      )}
    </Group>
  );
}
