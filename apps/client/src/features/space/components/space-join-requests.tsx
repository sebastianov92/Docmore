import { useTranslation } from "react-i18next";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { IconUserQuestion } from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import {
  useJoinRequestsQuery,
  useReviewJoinRequestMutation,
} from "@/features/space/queries/space-query";

// Pending join requests of a closed space, for its admins.
export default function SpaceJoinRequests({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const { data } = useJoinRequestsQuery(spaceId);
  const review = useReviewJoinRequestMutation();
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Alert variant="light" color="orange" icon={<IconUserQuestion />} mb="md" data-testid="join-requests">
      <Text size="sm" fw={500} mb="xs">
        {t("{{count}} join requests", { count: items.length })}
      </Text>
      <Stack gap="xs">
        {items.map((r) => (
          <Group key={r.id} justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <CustomAvatar avatarUrl={r.avatarUrl ?? undefined} name={r.name} size={28} />
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {r.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {r.note || r.email}
                </Text>
              </div>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Button size="xs" onClick={() => review.mutate({ requestId: r.id, approve: true })}>
                {t("Approve")}
              </Button>
              <Button size="xs" variant="default" onClick={() => review.mutate({ requestId: r.id, approve: false })}>
                {t("Reject")}
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
