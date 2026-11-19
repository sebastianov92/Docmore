import { useTranslation } from "react-i18next";
import { ActionIcon, Group, Menu, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconFileDescription, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { IBase } from "@/features/base/types/base.types";
import {
  useBaseTemplatesQuery,
  useCreateRowMutation,
  useDeleteRowMutation,
} from "@/features/base/queries/base-row-query";
import { rowTitle } from "@/features/base/components/views/cards/card-utils";

type Props = {
  base: IBase;
  // Opens a row (a template too) in the detail modal.
  onOpenRow: (rowId: string) => void;
};

// "Templates" toolbar menu: a row created from a template starts with the
// template's values. Templates are rows kept apart from the data.
export function RowTemplatesMenu({ base, onOpenRow }: Props) {
  const { t } = useTranslation();
  const { data } = useBaseTemplatesQuery(base.id);
  const createRow = useCreateRowMutation();
  const deleteRow = useDeleteRowMutation();
  const primary = base.properties.find((p) => p.isPrimary);
  const templates = data?.items ?? [];

  const useTemplate = (templateId: string) => {
    createRow.mutate({ pageId: base.id, fromTemplateId: templateId });
  };
  const newTemplate = async () => {
    try {
      const row = await createRow.mutateAsync({ pageId: base.id, isTemplate: true });
      onOpenRow(row.id);
    } catch {
      // the mutation shows the error
    }
  };
  const confirmDelete = (rowId: string, name: string) => {
    modals.openConfirmModal({
      title: t("Delete template"),
      centered: true,
      children: (
        <Text size="sm">
          {t("Delete the template")} <b>{name || t("Untitled")}</b>? {t("Rows made from it stay as they are.")}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteRow.mutate({ rowId, pageId: base.id }),
    });
  };

  return (
    <Menu shadow="md" width={260} position="bottom-end" withinPortal>
      <Menu.Target>
        <Tooltip label={t("Templates")}>
          <ActionIcon variant="subtle" size="sm" color={templates.length ? "blue" : "gray"} aria-label={t("Templates")}>
            <IconFileDescription size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("New row from template")}</Menu.Label>
        {templates.length === 0 && (
          <Text size="xs" c="dimmed" px="sm" py={4}>
            {t("No templates yet")}
          </Text>
        )}
        {templates.map((row) => {
          const name = rowTitle(row, primary);
          return (
            <Menu.Item
              key={row.id}
              onClick={() => useTemplate(row.id)}
              rightSection={
                <Group gap={2} wrap="nowrap">
                  <ActionIcon
                    variant="subtle"
                    size="xs"
                    color="gray"
                    aria-label={t("Edit template")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenRow(row.id);
                    }}
                  >
                    <IconPencil size={12} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="xs"
                    color="gray"
                    aria-label={t("Delete template")}
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmDelete(row.id, name);
                    }}
                  >
                    <IconTrash size={12} />
                  </ActionIcon>
                </Group>
              }
            >
              <Text size="sm" lineClamp={1}>
                {name || t("Untitled")}
              </Text>
            </Menu.Item>
          );
        })}
        <Menu.Divider />
        <Menu.Item leftSection={<IconPlus size={14} />} onClick={newTemplate}>
          {t("New template")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
