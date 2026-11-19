import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Anchor, Badge, Button, Group, Select, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { IBase, IBaseRow } from "@/features/base/types/base.types";
import { useCreateRowMutation, useUpdateRowMutation } from "@/features/base/queries/base-row-query";
import { useBaseRowReferences } from "@/features/base/hooks/use-base-row-references";

type Props = {
  base: IBase;
  row: IBaseRow;
  rows: IBaseRow[];
  canEdit: boolean;
  onOpenRow: (rowId: string) => void;
};

// Parent item, sub-items and dependencies of a row. Parent and "blocked
// by" are stored on the row; sub-items and "blocks" come from the loaded rows.
export function RowHierarchy({ base, row, rows, canEdit, onOpenRow }: Props) {
  const { t } = useTranslation();
  const updateRow = useUpdateRowMutation();
  const createRow = useCreateRowMutation();
  const references = useBaseRowReferences(base.id);
  const primary = base.properties.find((p) => p.isPrimary);
  const titleOf = (id: string) => {
    const loaded = rows.find((r) => r.id === id);
    const v = loaded && primary ? (loaded.cells[primary.id] as string) : undefined;
    return v || references.rows?.[id]?.title || t("Untitled");
  };
  const [pickingParent, setPickingParent] = useState(false);
  const [pickingDep, setPickingDep] = useState(false);
  const candidates = useMemo(
    () => rows.filter((r) => r.id !== row.id).map((r) => ({ value: r.id, label: titleOf(r.id) })),
    [rows, row.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const children = rows.filter((r) => r.parentRowId === row.id);
  const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
  const blocks = rows.filter((r) => Array.isArray(r.blockedBy) && r.blockedBy.includes(row.id));

  const setParent = (parentRowId: string | null) => {
    updateRow.mutate({ rowId: row.id, pageId: base.id, cells: {}, parentRowId });
    setPickingParent(false);
  };
  const addDependency = (id: string | null) => {
    if (id && !blockedBy.includes(id)) {
      updateRow.mutate({ rowId: row.id, pageId: base.id, cells: {}, blockedBy: [...blockedBy, id] });
    }
    setPickingDep(false);
  };
  const removeDependency = (id: string) => {
    const next = blockedBy.filter((x) => x !== id);
    updateRow.mutate({ rowId: row.id, pageId: base.id, cells: {}, blockedBy: next.length ? next : null });
  };
  const addSubItem = async () => {
    try {
      const created = await createRow.mutateAsync({ pageId: base.id, parentRowId: row.id, afterRowId: row.id });
      onOpenRow(created.id);
    } catch {
      // the mutation shows the error
    }
  };

  const chip = (id: string, onRemove?: () => void) => (
    <Badge
      key={id}
      variant="light"
      color="gray"
      style={{ cursor: "pointer", textTransform: "none" }}
      onClick={() => onOpenRow(id)}
      rightSection={
        onRemove ? (
          <span
            role="button"
            aria-label={t("Remove")}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            style={{ cursor: "pointer", marginLeft: 4 }}
          >
            ×
          </span>
        ) : undefined
      }
    >
      {titleOf(id)}
    </Badge>
  );

  return (
    <Stack gap="xs" mt="md" data-testid="row-hierarchy">
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" w={110}>
          {t("Parent item")}
        </Text>
        {pickingParent ? (
          <Select
            size="xs"
            data={candidates}
            value={row.parentRowId ?? null}
            onChange={setParent}
            searchable
            clearable
            placeholder={t("Pick a row")}
            comboboxProps={{ withinPortal: true }}
            onBlur={() => setPickingParent(false)}
            autoFocus
            w={260}
          />
        ) : row.parentRowId ? (
          <Group gap="xs">
            {chip(row.parentRowId, canEdit ? () => setParent(null) : undefined)}
            {canEdit && (
              <Anchor size="xs" component="button" type="button" onClick={() => setPickingParent(true)}>
                {t("Change")}
              </Anchor>
            )}
          </Group>
        ) : canEdit ? (
          <Anchor size="xs" component="button" type="button" onClick={() => setPickingParent(true)}>
            {t("Set a parent")}
          </Anchor>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Group>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Text size="xs" c="dimmed" w={110} pt={2}>
          {t("Sub-items")}
        </Text>
        <Group gap="xs">
          {children.map((c) => chip(c.id))}
          {canEdit && (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={addSubItem}>
              {t("Add sub-item")}
            </Button>
          )}
        </Group>
      </Group>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Text size="xs" c="dimmed" w={110} pt={2}>
          {t("Blocked by")}
        </Text>
        <Group gap="xs">
          {blockedBy.map((id) => chip(id, canEdit ? () => removeDependency(id) : undefined))}
          {pickingDep ? (
            <Select
              size="xs"
              data={candidates.filter((c) => !blockedBy.includes(c.value))}
              value={null}
              onChange={addDependency}
              searchable
              placeholder={t("Pick a row")}
              comboboxProps={{ withinPortal: true }}
              onBlur={() => setPickingDep(false)}
              autoFocus
              w={260}
            />
          ) : canEdit ? (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => setPickingDep(true)}>
              {t("Add")}
            </Button>
          ) : null}
        </Group>
      </Group>
      {blocks.length > 0 && (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Text size="xs" c="dimmed" w={110} pt={2}>
            {t("Blocks")}
          </Text>
          <Group gap="xs">{blocks.map((b) => chip(b.id))}</Group>
        </Group>
      )}
    </Stack>
  );
}
