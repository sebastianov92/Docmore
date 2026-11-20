import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import { getApiErrorMessage } from "@/lib/api-error";

// A hostname of its own for the space's public site (the proxy must send it here).
export default function SpacePublicHostname({ space }: { space: ISpace }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(space.publicHostname ?? "");
  const updateSpace = useUpdateSpaceMutation();
  const save = async () => {
    try {
      await updateSpace.mutateAsync({ spaceId: space.id, publicHostname: value.trim() ? value.trim().toLowerCase() : null } as any);
      notifications.show({ message: t("Public hostname saved") });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err), color: "red" });
    }
  };
  return (
    <div data-testid="space-public-hostname">
      <Text size="md">{t("Custom domain for the public site")}</Text>
      <Text size="sm" c="dimmed" mb="xs">
        {t("Visitors of this hostname land on the published space. Point the domain at this server (DNS + reverse proxy) first.")}
      </Text>
      <Group gap="xs">
        <TextInput size="xs" w={280} placeholder="docs.example.com" value={value} onChange={(e) => setValue(e.currentTarget.value)} />
        <Button size="xs" variant="default" onClick={save} loading={updateSpace.isPending} disabled={(space.publicHostname ?? "") === value.trim().toLowerCase()}>
          {t("Save")}
        </Button>
      </Group>
    </div>
  );
}
