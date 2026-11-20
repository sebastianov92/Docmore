import { useState } from "react";
import { NodeViewProps, NodeViewWrapper, useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ActionIcon, Button, Group, Popover, Select, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay, IconSettings } from "@tabler/icons-react";
import { listAutomations, listBases, runAutomation } from "@/features/base/services/base-service";
import { usePageQuery } from "@/features/page/queries/page-query";
import { getApiErrorMessage } from "@/lib/api-error";

// A button block: press it to run an automation of a base in this space.
export default function BaseButtonView({ node, editor, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  const { label, pageId, automationId } = node.attrs as { label: string; pageId: string | null; automationId: string | null };
  const isEditable = useEditorState({ editor, selector: ({ editor }) => editor?.isEditable ?? false });
  const [configOpen, setConfigOpen] = useState(!automationId && isEditable);
  const [running, setRunning] = useState(false);
  // @ts-ignore
  const parentPageId = editor.storage?.pageId as string | undefined;
  const { data: page } = usePageQuery({ pageId: parentPageId });
  const spaceId = page?.spaceId;
  const { data: bases } = useQuery({ queryKey: ["bases-list", spaceId], queryFn: () => listBases(spaceId as string, { limit: 100 }), enabled: Boolean(spaceId) && configOpen });
  const { data: automations } = useQuery({ queryKey: ["base-automations", pageId], queryFn: () => listAutomations(pageId as string), enabled: Boolean(pageId) && configOpen });

  const run = async () => {
    if (!pageId || !automationId) return;
    setRunning(true);
    try {
      const r = await runAutomation({ pageId, automationId });
      notifications.show({ message: r.ok === false ? r.errors?.join("; ") || t("Automation failed") : t("Done"), color: r.ok === false ? "red" : undefined });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err), color: "red" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <NodeViewWrapper data-type="base-button" data-drag-handle>
      <Group gap={6} wrap="nowrap" contentEditable={false}>
        <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />} onClick={run} loading={running} disabled={!automationId} data-testid="base-button-block">
          {label || t("Run")}
        </Button>
        {isEditable && (
          <Popover opened={configOpen} onChange={setConfigOpen} position="bottom-start" withinPortal shadow="md" width={320}>
            <Popover.Target>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setConfigOpen((o) => !o)} aria-label={t("Button settings")}>
                <IconSettings size={14} />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                <TextInput size="xs" label={t("Label")} value={label ?? ""} onChange={(e) => updateAttributes({ label: e.currentTarget.value })} />
                <Select
                  size="xs"
                  label={t("Base")}
                  placeholder={t("Pick a base")}
                  data={(bases?.items ?? []).map((b) => ({ value: b.id, label: b.name || t("Untitled") }))}
                  value={pageId}
                  onChange={(v) => updateAttributes({ pageId: v, automationId: null })}
                  searchable
                  comboboxProps={{ withinPortal: true }}
                />
                <Select
                  size="xs"
                  label={t("Automation")}
                  placeholder={t("Pick an automation")}
                  data={(automations?.items ?? []).map((a) => ({ value: a.id, label: a.name }))}
                  value={automationId}
                  onChange={(v) => updateAttributes({ automationId: v })}
                  disabled={!pageId}
                  comboboxProps={{ withinPortal: true }}
                />
              </Stack>
            </Popover.Dropdown>
          </Popover>
        )}
      </Group>
    </NodeViewWrapper>
  );
}
