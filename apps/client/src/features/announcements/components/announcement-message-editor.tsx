import { useEffect, useState } from "react";
import { ActionIcon, Button, Group, Popover, Text, TextInput } from "@mantine/core";
import { IconBold, IconItalic, IconLink, IconUnderline } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Document } from "@tiptap/extension-document";
import { Placeholder } from "@tiptap/extension-placeholder";
import { AnnouncementContent } from "../types";
import { isSafeAnnouncementHref } from "../utils";
import classes from "./announcement-form.module.css";

interface Props {
  value: AnnouncementContent | null;
  onChange: (content: AnnouncementContent) => void;
  error?: string;
}

// One paragraph with bold, italic, underline and links: Enter does nothing
// and pasted blocks flatten, so the banner never gets more than it shows.
export function AnnouncementMessageEditor({ value, onChange, error }: Props) {
  const { t } = useTranslation();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [, bump] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        document: false,
        blockquote: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
        strike: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: "https",
          isAllowedUri: (url) => isSafeAnnouncementHref(url),
        },
      }),
      Document.extend({ content: "paragraph" }),
      Placeholder.configure({ placeholder: t("What should people read?") }),
    ],
    content: value ?? undefined,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { role: "textbox", "aria-label": t("Announcement message"), "aria-multiline": "false" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          return true;
        }
        return false;
      },
      transformPastedText: (text) => text.replace(/\s*\n+\s*/g, " "),
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as unknown as AnnouncementContent),
    onSelectionUpdate: () => bump((n) => n + 1),
    onTransaction: () => bump((n) => n + 1),
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  const openLink = () => {
    if (!editor) return;
    setLinkValue(editor.getAttributes("link").href ?? "");
    setLinkOpen(true);
  };
  const applyLink = () => {
    if (!editor) return;
    const href = linkValue.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else if (isSafeAnnouncementHref(href)) {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    } else {
      return;
    }
    setLinkOpen(false);
  };

  const active = (name: string) => editor?.isActive(name) || undefined;

  return (
    <div className={classes.editor} data-error={error ? true : undefined}>
      <Group gap={4} className={classes.toolbar}>
        <ActionIcon variant="subtle" color="gray" size="sm" data-active={active("bold")} aria-label={t("Bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <IconBold size={15} />
        </ActionIcon>
        <ActionIcon variant="subtle" color="gray" size="sm" data-active={active("italic")} aria-label={t("Italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <IconItalic size={15} />
        </ActionIcon>
        <ActionIcon variant="subtle" color="gray" size="sm" data-active={active("underline")} aria-label={t("Underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          <IconUnderline size={15} />
        </ActionIcon>
        <Popover opened={linkOpen} onChange={setLinkOpen} position="bottom-start" width={320} shadow="md" trapFocus>
          <Popover.Target>
            <ActionIcon variant="subtle" color="gray" size="sm" data-active={active("link")} aria-label={t("Link")} onClick={openLink}>
              <IconLink size={15} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <TextInput
              size="xs"
              placeholder="https://… or /s/space/p/page"
              value={linkValue}
              onChange={(e) => setLinkValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                }
              }}
              error={linkValue.trim() && !isSafeAnnouncementHref(linkValue) ? t("Use http, https, mailto or a path in this app") : undefined}
              data-autofocus
            />
            <Group justify="flex-end" gap="xs" mt="xs">
              <Button size="compact-xs" variant="default" onClick={() => setLinkOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button size="compact-xs" onClick={applyLink}>
                {linkValue.trim() ? t("Apply") : t("Remove link")}
              </Button>
            </Group>
          </Popover.Dropdown>
        </Popover>
      </Group>
      <EditorContent editor={editor} className={classes.content} />
      {error && (
        <Text size="xs" c="red" mt={4}>
          {error}
        </Text>
      )}
    </div>
  );
}
