import { Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { ITemplate } from "@/features/template/types/template.types.ts";

export function TemplateMeta({ template }: { template: ITemplate }) {
  const { t } = useTranslation();
  const updatedAgo = useTimeAgo(template.updatedAt);

  return (
    <Group gap={8} mt="xs" wrap="nowrap">
      {template.creator?.name && (
        <>
          <CustomAvatar
            size={22}
            radius="xl"
            name={template.creator.name}
            avatarUrl={template.creator.avatarUrl}
          />
          <Text size="sm" c="dimmed" fw={500}>
            {template.creator.name}
          </Text>
        </>
      )}
      {updatedAgo && (
        <Text size="sm" c="dimmed">
          {t("Updated {{time}}", { time: updatedAgo })}
        </Text>
      )}
    </Group>
  );
}
