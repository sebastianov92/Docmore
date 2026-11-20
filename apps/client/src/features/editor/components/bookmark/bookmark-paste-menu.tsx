import { Button, Paper, Text } from "@mantine/core";
import { posToDOMRect, useEditorState } from "@tiptap/react";
import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorMenuProps } from "@/features/editor/components/table/types/types.ts";
import { bookmarkPasteMenuKey } from "@/features/editor/extensions/bookmark-paste-menu";
import { getBlockPlacement } from "@/features/editor/utils/block-placement";
import classes from "../integration-link/integration-paste-menu.module.css";

function pasted(editor: EditorMenuProps["editor"]) {
  const state = bookmarkPasteMenuKey.getState(editor.state);
  if (!state) return null;
  const text = editor.state.doc.textBetween(state.from, Math.min(state.to, editor.state.doc.content.size), "\n", "\n");
  return text === state.url ? state : null;
}

// After a web address is pasted: keep the link, or turn it into a bookmark card.
export function BookmarkPasteMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();
  const [highlighted, setHighlighted] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const state = useEditorState({ editor, selector: ({ editor: e }) => (e ? pasted(e) : null) });
  const isOpen = state !== null;

  const dismiss = useCallback(() => {
    if (!bookmarkPasteMenuKey.getState(editor.state)) return;
    editor.view.dispatch(editor.state.tr.setMeta(bookmarkPasteMenuKey, null));
  }, [editor]);

  const convert = useCallback(() => {
    const s = pasted(editor);
    if (!s) return;
    dismiss();
    const type = editor.schema.nodes.bookmark;
    if (!type) return;
    const placement = getBlockPlacement(editor.state.doc, s.from, s.to, type.create({ url: s.url }));
    if (!placement) return;
    editor.commands.command(({ tr }) => {
      tr.replaceWith(placement.range.from, placement.range.to, placement.content);
      return true;
    });
    editor.commands.focus(undefined, { scrollIntoView: false });
  }, [dismiss, editor]);

  useEffect(() => setHighlighted(false), [state?.from]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (editor.isDestroyed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted(true);
      } else if (event.key === "Enter" && highlighted) {
        event.preventDefault();
        event.stopPropagation();
        convert();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [convert, dismiss, editor, highlighted, isOpen]);

  const getReferencedVirtualElement = useCallback(() => {
    const s = pasted(editor);
    if (!s) return undefined;
    const rect = posToDOMRect(editor.view, s.from, s.to);
    return { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  }, [editor]);

  return (
    <BaseBubbleMenu
      editor={editor}
      pluginKey="bookmark-paste-menu"
      ref={(element) => {
        if (element) element.style.zIndex = "99";
      }}
      updateDelay={0}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={{ placement: "bottom-start", offset: 10, flip: true, shift: true }}
      shouldShow={() => pasted(editor) !== null}
    >
      {isOpen ? (
        <Paper ref={promptRef} shadow="md" radius="md" withBorder p={4} miw={140} role="listbox" aria-label={t("Paste as")} data-testid="bookmark-paste-menu">
          <Text size="xs" c="dimmed" px={8} py={4}>
            {t("Paste as")}
          </Text>
          <Button
            role="option"
            aria-selected={highlighted}
            variant={highlighted ? "light" : "subtle"}
            color="gray"
            size="compact-sm"
            fullWidth
            justify="flex-start"
            className={classes.pasteOption}
            onMouseEnter={() => setHighlighted(true)}
            onMouseLeave={() => setHighlighted(false)}
            onClick={convert}
          >
            {t("Bookmark")}
          </Button>
        </Paper>
      ) : null}
    </BaseBubbleMenu>
  );
}
