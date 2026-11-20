import "@/features/editor/styles/index.css";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Group, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { EditorContent, useEditor } from "@tiptap/react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import historyClasses from "@/features/page-history/components/css/history.module.css";
import { IPage } from "@/features/page/types/page.types";
import { getApiErrorMessage } from "@/lib/api-error";
import { createSuggestion, SUGGESTION_COUNT_KEY, SUGGESTIONS_KEY, suggestEditorOpenAtom } from "../services";

// Suggest mode: a private copy of the page to edit; "Propose" turns it into
// a suggestion that an editor accepts or rejects. Nothing touches the page
// until then.
export function SuggestEditorModal({ page }: { page: IPage | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useAtom(suggestEditorOpenAtom);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const editor = useEditor({ extensions: mainExtensions, editable: true, content: "", textDirection: "auto" });

  useEffect(() => {
    if (!open || !editor || editor.isDestroyed) return;
    editor.commands.setContent((page?.content as any) ?? { type: "doc", content: [{ type: "paragraph" }] });
    setTitle(page?.title ?? "");
    setNote("");
    requestAnimationFrame(() => editor.commands.focus("start"));
  }, [open, editor, page?.id]);

  const propose = async () => {
    if (!page || !editor) return;
    setSaving(true);
    try {
      await createSuggestion({ pageId: page.id, content: editor.getJSON(), title: title.trim() !== (page.title ?? "") ? title.trim() : undefined, note: note.trim() || undefined });
      notifications.show({ message: t("Suggestion sent. Editors of this page will review it.") });
      queryClient.invalidateQueries({ queryKey: SUGGESTIONS_KEY(page.id) });
      queryClient.invalidateQueries({ queryKey: SUGGESTION_COUNT_KEY(page.id) });
      setOpen(false);
    } catch (err) {
      notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not send the suggestion")) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={open} onClose={() => setOpen(false)} fullScreen title={t("Suggest edits")} data-testid="suggest-editor">
      <Stack gap="sm" maw={960} mx="auto">
        <Text size="sm" c="dimmed">
          {t("You are editing a copy. When you propose it, whoever can edit the page sees your changes side by side and accepts or rejects them.")}
        </Text>
        <TextInput label={t("Title")} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <div className={historyClasses.historyEditor} style={{ minHeight: 320, border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: "8px 16px" }}>
          <EditorContent editor={editor} />
        </div>
        <Textarea label={t("Why this change?")} placeholder={t("Optional note for the reviewer")} autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={propose} loading={saving} data-testid="suggest-propose">
            {t("Propose")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
