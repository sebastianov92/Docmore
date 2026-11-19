import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useDebouncedValue } from "@mantine/hooks";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import {
  useBrowseSpacesQuery,
  useJoinSpaceMutation,
  useRequestJoinSpaceMutation,
} from "@/features/space/queries/space-query";
import { IBrowseSpace } from "@/features/space/types/space.types";
import { formatMemberCount } from "@/lib";

// Spaces the user is not in yet: open ones join at once, closed ones ask
// the space admins.
export default function BrowseSpaces() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search, 300);
  const { data } = useBrowseSpacesQuery({ limit: 50, query });
  const join = useJoinSpaceMutation();
  const request = useRequestJoinSpaceMutation();
  const items = data?.items ?? [];
  if (items.length === 0 && !query) return null;

  const action = (space: IBrowseSpace) => {
    if (space.visibility === "open") {
      return (
        <Button size="xs" onClick={() => join.mutate(space.id)} loading={join.isPending}>
          {t("Join")}
        </Button>
      );
    }
    if (space.requested) {
      return (
        <Badge variant="light" color="gray">
          {t("Requested")}
        </Badge>
      );
    }
    return (
      <Button
        size="xs"
        variant="default"
        onClick={() => request.mutate({ spaceId: space.id })}
        loading={request.isPending}
      >
        {t("Request to join")}
      </Button>
    );
  };

  return (
    <Stack gap="sm" mt="xl" data-testid="browse-spaces">
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed">
          {t("Spaces you can join")}
        </Text>
        <TextInput
          size="xs"
          placeholder={t("Find a space")}
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={220}
        />
      </Group>
      {items.map((space) => (
        <Paper key={space.id} withBorder p="sm" radius="md">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <CustomAvatar avatarUrl={space.logo ?? undefined} name={space.name} size={36} />
              <div style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text fw={500} size="sm" truncate>
                    {space.name}
                  </Text>
                  <Badge size="xs" variant="light" color={space.visibility === "open" ? "green" : "orange"}>
                    {space.visibility === "open" ? t("Open") : t("Closed")}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" lineClamp={1}>
                  {space.description || formatMemberCount(space.memberCount, t)}
                </Text>
              </div>
            </Group>
            {action(space)}
          </Group>
        </Paper>
      ))}
      {items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("No spaces match")}
        </Text>
      )}
    </Stack>
  );
}
