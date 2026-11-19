import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { Anchor, Badge, Container, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { useMemberProfileQuery, usePagesByCreatorQuery } from "@/features/people/people-queries";
import { getUserRoleLabel } from "@/features/workspace/types/user-role-data.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { getPageIcon } from "@/lib";
import { formattedDate, timeAgo } from "@/lib/time";
import { Error404 } from "@/components/ui/error-404.tsx";

// One person: who they are and the pages they created.
export default function PersonPage() {
  const { t } = useTranslation();
  const { userId } = useParams();
  const { data: person, isError } = useMemberProfileQuery(userId);
  const { data: pages } = usePagesByCreatorQuery(userId);
  if (isError) return <Error404 />;
  if (!person) return null;
  return (
    <>
      <DocumentTitle title={person.name} />
      <Container size={"800"} pt="xl">
        <Anchor component={Link} to="/people" size="sm" c="dimmed">
          {t("People")}
        </Anchor>
        <Group gap="md" mt="md" mb="xl" wrap="nowrap" align="flex-start">
          <CustomAvatar avatarUrl={person.avatarUrl ?? undefined} name={person.name} size={72} />
          <div style={{ minWidth: 0 }}>
            <Group gap="sm">
              <Title order={1} size="h3">
                {person.name}
              </Title>
              <Badge variant="light">{t(getUserRoleLabel(person.role))}</Badge>
              {person.deactivatedAt && (
                <Badge variant="light" color="gray">
                  {t("Deactivated")}
                </Badge>
              )}
            </Group>
            <Anchor href={`mailto:${person.email}`} size="sm">
              {person.email}
            </Anchor>
            <Text size="xs" c="dimmed" mt={4}>
              {t("Member since {{date}}", { date: formattedDate(new Date(person.createdAt)) })}
              {person.lastActiveAt ? ` · ${t("Last active {{time}}", { time: timeAgo(new Date(person.lastActiveAt)) })}` : ""}
              {person.timezone ? ` · ${person.timezone}` : ""}
            </Text>
          </div>
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          {t("Pages created")}
        </Text>
        <Stack gap="xs" data-testid="person-pages">
          {(pages ?? []).map((page) => (
            <Paper key={page.id} withBorder p="sm" radius="md">
              <Anchor
                component={Link}
                to={buildPageUrl(page.space?.slug ?? "", page.slugId, page.title)}
                underline="never"
                c="inherit"
              >
                <Group gap={6} wrap="nowrap">
                  {getPageIcon(page.icon)}
                  <Text size="sm" fw={500} truncate>
                    {page.title || t("untitled")}
                  </Text>
                  {page.space?.name && (
                    <Text size="xs" c="dimmed">
                      {page.space.name}
                    </Text>
                  )}
                </Group>
              </Anchor>
            </Paper>
          ))}
          {pages && pages.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("No pages yet")}
            </Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
