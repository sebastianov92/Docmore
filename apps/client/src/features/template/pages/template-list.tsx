import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Center,
  Container,
  Group,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconPlus, IconTemplate } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import {
  useDeleteTemplateMutation,
  useTemplatesQuery,
} from "@/features/template/queries/template-query.ts";
import { ITemplate } from "@/features/template/types/template.types.ts";
import { templateTitle } from "@/features/template/template.utils.ts";
import { TemplateCard } from "@/features/template/components/template-card.tsx";
import { CreateTemplateModal } from "@/features/template/components/create-template-modal.tsx";
import { TemplatePreviewModal } from "@/features/template/components/template-preview-modal.tsx";
import { UseTemplateModal } from "@/features/template/components/use-template-modal.tsx";

const ALL = "";

export default function TemplateList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useUserRole();
  const workspace = useAtomValue(workspaceAtom);
  const user = useAtomValue(userAtom);
  const membersMayManage = workspace?.settings?.templates?.allowMemberTemplates === true;
  const canCreate = isAdmin || membersMayManage;

  const [spaceFilter, setSpaceFilter] = useState<string>(ALL);
  const [createOpened, setCreateOpened] = useState(false);
  const [previewing, setPreviewing] = useState<ITemplate | null>(null);
  const [using, setUsing] = useState<ITemplate | null>(null);

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useTemplatesQuery({ spaceId: spaceFilter || undefined });
  const templates = data?.pages.flatMap((page) => page.items) ?? [];

  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const { data: archivedSpaces } = useGetSpacesQuery({ limit: 100, status: "archived" });
  const deleteMutation = useDeleteTemplateMutation();

  const spaceNames = useMemo(
    () =>
      new Map(
        [...(spaces?.items ?? []), ...(archivedSpaces?.items ?? [])].map((space) => [
          space.id,
          space.name,
        ]),
      ),
    [spaces, archivedSpaces],
  );

  const filterOptions = [
    { value: ALL, label: t("All templates") },
    ...(spaces?.items?.map((space) => ({ value: space.id, label: space.name })) ?? []),
    ...(archivedSpaces?.items?.length
      ? [
          {
            group: t("Archived"),
            items: archivedSpaces.items.map((space) => ({ value: space.id, label: space.name })),
          },
        ]
      : []),
  ];

  const canManage = (template: ITemplate) =>
    isAdmin || (membersMayManage && !!template.spaceId && template.creatorId === user?.id);

  const scopeLabel = (template: ITemplate) =>
    template.spaceId
      ? spaceNames.get(template.spaceId) ?? t("Space")
      : t("Everyone in the workspace");

  const confirmDelete = (template: ITemplate) => {
    modals.openConfirmModal({
      title: t("Delete template"),
      centered: true,
      children: (
        <Text size="sm">
          {t('"{{title}}" will be removed. Pages already created from it are not affected.', {
            title: templateTitle(template, t("Untitled")),
          })}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(template.id),
    });
  };

  return (
    <>
      <DocumentTitle title={t("Templates")} />

      <Container size={900} pt="xl" pb="xl">
        <Group justify="space-between" mb="lg" wrap="nowrap">
          <div>
            <Title order={3}>{t("Templates")}</Title>
            <Text size="sm" c="dimmed">
              {t("Reusable starting points for new pages.")}
            </Text>
          </div>
          {canCreate && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpened(true)}>
              {t("New template")}
            </Button>
          )}
        </Group>

        <Group mb="lg">
          <Select
            data={filterOptions}
            value={spaceFilter}
            onChange={(value) => setSpaceFilter(value ?? ALL)}
            aria-label={t("Filter by space")}
            allowDeselect={false}
            searchable
            size="sm"
            w={240}
            comboboxProps={{ width: "target" }}
          />
        </Group>

        {isLoading ? (
          <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
            {Array.from({ length: 6 }).map((_, index) => (
              <Card key={index} radius="md" padding="lg" withBorder>
                <Skeleton width={36} height={36} radius="md" mb="md" />
                <Skeleton height={14} width="70%" mb={8} />
                <Skeleton height={10} width="40%" />
              </Card>
            ))}
          </SimpleGrid>
        ) : templates.length === 0 ? (
          <Center py={60}>
            <Stack align="center" gap="xs">
              <IconTemplate size={36} stroke={1.2} color="var(--mantine-color-gray-5)" />
              <Text fw={500}>{t("No templates yet")}</Text>
              <Text size="sm" c="dimmed" ta="center">
                {canCreate
                  ? t("Create one and it will show up here and in the page editor.")
                  : t("An admin can create templates for the workspace.")}
              </Text>
            </Stack>
          </Center>
        ) : (
          <>
            <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  scopeLabel={scopeLabel(template)}
                  canManage={canManage(template)}
                  onOpen={setPreviewing}
                  onUse={setUsing}
                  onEdit={(item) => navigate(`/templates/${item.id}`)}
                  onDelete={confirmDelete}
                />
              ))}
            </SimpleGrid>
            {hasNextPage && (
              <Button
                variant="subtle"
                fullWidth
                mt="md"
                onClick={() => fetchNextPage()}
                loading={isFetchingNextPage}
              >
                {t("Load more")}
              </Button>
            )}
          </>
        )}
      </Container>

      <CreateTemplateModal opened={createOpened} onClose={() => setCreateOpened(false)} />

      {previewing && (
        <TemplatePreviewModal
          templateId={previewing.id}
          opened={true}
          onClose={() => setPreviewing(null)}
          onUse={() => {
            setUsing(previewing);
            setPreviewing(null);
          }}
          onEdit={canManage(previewing) ? () => navigate(`/templates/${previewing.id}`) : undefined}
        />
      )}

      {using && <UseTemplateModal template={using} opened={true} onClose={() => setUsing(null)} />}
    </>
  );
}
