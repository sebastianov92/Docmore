import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button, Group, Select, Text } from "@mantine/core";
import type { Editor } from "@tiptap/core";
import { usePageQuery } from "@/features/page/queries/page-query";
import { useBaseQuery } from "@/features/base/queries/base-query";
import { listBases } from "@/features/base/services/base-service";

type Props = {
  editor: Editor;
  onPick: (pageId: string, viewId: string | null) => void;
  onCancel: () => void;
};

// Inline picker for a "linked view" embed: a base of this space, then one
// of its views. Several of these on a page make a dashboard.
export function LinkedViewPicker({ editor, onPick, onCancel }: Props) {
  const { t } = useTranslation();
  // @ts-ignore
  const parentPageId = editor.storage?.pageId as string | undefined;
  const { data: page } = usePageQuery({ pageId: parentPageId });
  const spaceId = page?.spaceId;
  const { data: bases } = useQuery({
    queryKey: ["bases-list", spaceId],
    queryFn: () => listBases(spaceId as string, { limit: 100 }),
    enabled: Boolean(spaceId),
  });
  const [baseId, setBaseId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const { data: base } = useBaseQuery(baseId ?? "");
  const baseOptions = useMemo(
    () => (bases?.items ?? []).map((b) => ({ value: b.id, label: b.name || t("Untitled") })),
    [bases, t],
  );
  const viewOptions = useMemo(
    () => (base?.views ?? []).map((v) => ({ value: v.id, label: `${v.name} (${v.type})` })),
    [base],
  );
  return (
    <Group gap="xs" p="sm" wrap="wrap" data-testid="linked-view-picker" contentEditable={false}>
      <Text size="sm" fw={500}>
        {t("Linked view")}
      </Text>
      <Select
        size="xs"
        w={200}
        placeholder={t("Pick a base")}
        data={baseOptions}
        value={baseId}
        onChange={(v) => {
          setBaseId(v);
          setViewId(null);
        }}
        searchable
        comboboxProps={{ withinPortal: true }}
      />
      <Select
        size="xs"
        w={200}
        placeholder={t("Pick a view")}
        data={viewOptions}
        value={viewId}
        onChange={(v) => setViewId(v)}
        disabled={!base}
        comboboxProps={{ withinPortal: true }}
      />
      <Button size="xs" disabled={!baseId} onClick={() => baseId && onPick(baseId, viewId)}>
        {t("Insert")}
      </Button>
      <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
        {t("Cancel")}
      </Button>
    </Group>
  );
}
