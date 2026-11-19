import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Badge,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useDebouncedValue } from "@mantine/hooks";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query.ts";
import { getUserRoleLabel } from "@/features/workspace/types/user-role-data.ts";
import Paginate from "@/components/common/paginate.tsx";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";

// Who is in the workspace: name, email and role, each card opens a profile.
export default function PeoplePage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search, 300);
  const { cursor, goNext, goPrev } = useCursorPaginate();
  const { data } = useWorkspaceMembersQuery({ limit: 48, query, cursor } as any);
  const people = data?.items ?? [];
  return (
    <>
      <DocumentTitle title={t("People")} />
      <Container size={"800"} pt="xl">
        <Group justify="space-between" mb="xl">
          <Title order={1} size="h3">
            {t("People")}
          </Title>
          <TextInput
            placeholder={t("Find a person")}
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={240}
            aria-label={t("Find a person")}
          />
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          {people.map((person) => (
            <UnstyledButton
              key={person.id}
              component={Link}
              to={`/people/${person.id}`}
              style={{ display: "block" }}
              data-testid="person-card"
            >
              <Paper withBorder p="sm" radius="md" h="100%">
                <Group gap="sm" wrap="nowrap">
                  <CustomAvatar avatarUrl={person.avatarUrl} name={person.name} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text fw={500} size="sm" truncate>
                        {person.name}
                      </Text>
                      <Badge size="xs" variant="light">
                        {t(getUserRoleLabel(person.role))}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {person.email}
                    </Text>
                  </div>
                </Group>
              </Paper>
            </UnstyledButton>
          ))}
        </SimpleGrid>
        {people.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("No people match")}
          </Text>
        )}
        <Paginate
          hasPrevPage={data?.meta?.hasPrevPage}
          hasNextPage={data?.meta?.hasNextPage}
          onPrev={goPrev}
          onNext={() => goNext(data?.meta?.nextCursor)}
        />
      </Container>
    </>
  );
}
