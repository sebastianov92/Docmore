import { useTranslation } from "react-i18next";
import { Alert, Avatar, Button, Group, Table, Text } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import {
  useInviteRequestsQuery,
  useReviewInviteRequestMutation,
} from "@/features/workspace/queries/workspace-query.ts";
import { timeAgo } from "@/lib/time";

// Admin view: who asked to invite whom; approving sends the invitation.
export default function InviteRequestsTable() {
  const { t } = useTranslation();
  const { data } = useInviteRequestsQuery();
  const review = useReviewInviteRequestMutation();
  const items = data?.items ?? [];
  return (
    <>
      <Alert variant="light" color="blue" icon={<IconInfoCircle />}>
        {t("Members asked to invite these people. Approving sends the invitation as a member.")}
      </Alert>
      <Table.ScrollContainer minWidth={600}>
        <Table highlightOnHover verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Email")}</Table.Th>
              <Table.Th>{t("Requested by")}</Table.Th>
              <Table.Th>{t("Note")}</Table.Th>
              <Table.Th>{t("Date")}</Table.Th>
              <Table.Th aria-label={t("Action")} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((r) => (
              <Table.Tr key={r.id} data-testid="invite-request-row">
                <Table.Td>
                  <Group gap="sm" wrap="nowrap">
                    <Avatar name={r.email} color="initials" />
                    <Text fz="sm" fw={500}>
                      {r.email}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td>{r.requesterName}</Table.Td>
                <Table.Td>
                  <Text size="sm" lineClamp={2}>
                    {r.note || "—"}
                  </Text>
                </Table.Td>
                <Table.Td>{timeAgo(new Date(r.createdAt))}</Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap" justify="flex-end">
                    <Button size="xs" onClick={() => review.mutate({ requestId: r.id, approve: true })}>
                      {t("Approve")}
                    </Button>
                    <Button size="xs" variant="default" onClick={() => review.mutate({ requestId: r.id, approve: false })}>
                      {t("Reject")}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
            {items.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    {t("No pending requests")}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </>
  );
}
