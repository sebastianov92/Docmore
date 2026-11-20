import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowUp, IconAt, IconCheck, IconFile, IconPaperclip, IconPhoto, IconPlayerStopFilled, IconPlus, IconSparkles, IconTelescope, IconX, IconFileText } from "@tabler/icons-react";
import { TextInput } from "@mantine/core";
import { ISkill, useUsableSkillsQuery } from "@/features/ai/skills/services";
import { useTranslation } from "react-i18next";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Mention } from "@docmost/editor-ext";
import mentionRenderItems from "@/features/editor/components/mention/mention-suggestion";
import MentionView from "@/features/editor/components/mention/mention-view";
import { getApiErrorMessage } from "@/lib/api-error";
import { uploadChatFile } from "../services";
import { CHAT_ACCEPTED_FILES, CHAT_IMAGE_EXTENSIONS, ChatAttachment, MAX_ATTACHMENTS_PER_MESSAGE, PageMention, SendExtras } from "../types";
import chatClasses from "./chat.module.css";
import classes from "./chat-input.module.css";

export interface ChatInputHandle {
  prefill: (text: string) => void;
  focus: () => void;
}

interface Props {
  isStreaming: boolean;
  onSend: (content: string, mentions: PageMention[], attachments: ChatAttachment[], extras?: SendExtras) => void;
  onStop: () => void;
  placeholder?: string;
  autofocus?: boolean;
  contextPages?: PageMention[];
  onRemoveContextPage?: (pageId: string) => void;
  variant?: "card" | "flat";
  chatId?: string;
}

type Pending = ChatAttachment & { uploading: boolean };

// Walks the editor document: plain text with @Title for mentions, and the
// pages mentioned.
function readEditor(json: any): { text: string; mentions: PageMention[] } {
  const mentions: PageMention[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  let line = "";
  const walk = (node: any) => {
    if (node.type === "paragraph" || node.type === "heading") {
      if (line || lines.length) lines.push(line);
      line = "";
      node.content?.forEach(walk);
      return;
    }
    if (node.type === "hardBreak") {
      lines.push(line);
      line = "";
      return;
    }
    if (node.type === "text") line += node.text ?? "";
    else if (node.type === "mention") {
      line += `@${node.attrs?.label ?? ""}`;
      const id = node.attrs?.entityId;
      if (node.attrs?.entityType === "page" && id && !seen.has(id)) {
        seen.add(id);
        mentions.push({ id, title: node.attrs?.label ?? "", slugId: node.attrs?.slugId ?? "" });
      }
    } else node.content?.forEach(walk);
  };
  walk(json);
  lines.push(line);
  return { text: lines.join("\n").trim(), mentions };
}

// The message box: a small TipTap editor so @ mentions pages like in the
// page editor, with file chips, Enter to send and Shift+Enter for a new line.
const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { isStreaming, onSend, onStop, placeholder, autofocus = true, contextPages, onRemoveContextPage, variant = "card", chatId },
  ref,
) {
  const { t } = useTranslation();
  const [empty, setEmpty] = useState(true);
  const [pending, setPending] = useState<Pending[]>([]);
  // a skill steering this message, and research mode (a long report with sources)
  const [skill, setSkill] = useState<ISkill | null>(null);
  const [research, setResearch] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skills = useUsableSkillsQuery();
  const skillsRef = useRef<{ open: () => void }>({ open: () => setSkillsOpen(true) });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<() => void>(() => {});
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const hint = research ? t("Ask a question for a full report with sources.") : placeholder || t("Ask anything. Type @ to mention a page, / for a skill.");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ gapcursor: false, dropcursor: false, link: false, heading: false, codeBlock: false }),
      Placeholder.configure({ placeholder: hint }),
      Mention.configure({
        suggestion: {
          allowSpaces: true,
          items: () => [],
          // @ts-ignore the renderer manages its own popup
          render: mentionRenderItems,
        },
        HTMLAttributes: { class: "mention" },
      }).extend({
        addNodeView() {
          return ReactNodeViewRenderer(MentionView);
        },
      }),
    ],
    editorProps: {
      attributes: { role: "textbox", "aria-label": hint, "aria-multiline": "true" },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key) && document.querySelector("#mention")) {
            return true;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitRef.current();
            return true;
          }
          // "/" in an empty box opens the skill picker
          if (event.key === "/" && !_view.state.doc.textContent.trim()) {
            event.preventDefault();
            skillsRef.current.open();
            return true;
          }
          return false;
        },
      },
    },
    content: "",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    autofocus: autofocus ? "end" : false,
    onUpdate: ({ editor: e }) => setEmpty(!e.getText().trim()),
  });

  const addFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const room = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
      const accepted = Array.from(files).slice(0, Math.max(room, 0));
      if (accepted.length < files.length) {
        notifications.show({
          color: "yellow",
          message: t("Up to {{max}} files per message", { max: MAX_ATTACHMENTS_PER_MESSAGE }),
        });
      }
      for (const file of accepted) {
        const tempId = `uploading-${Date.now()}-${Math.random()}`;
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        setPending((prev) => [
          ...prev,
          { id: tempId, fileName: file.name, fileExt: ext, fileSize: file.size, mimeType: file.type, uploading: true },
        ]);
        try {
          const uploaded = await uploadChatFile(file, chatIdRef.current);
          setPending((prev) => prev.map((p) => (p.id === tempId ? { ...uploaded, uploading: false } : p)));
        } catch (err) {
          setPending((prev) => prev.filter((p) => p.id !== tempId));
          notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not upload the file")) });
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pending.length, t],
  );

  const submit = useCallback(() => {
    if (!editor || editor.isDestroyed || isStreaming) return;
    const { text, mentions } = readEditor(editor.getJSON());
    const ready = pending.filter((p) => !p.uploading);
    if (!text && ready.length === 0) return;
    onSend(text, mentions, ready, { skillId: skill?.id, skillName: skill?.name, research: research || undefined });
    editor.commands.clearContent();
    editor.commands.focus();
    setPending([]);
    setEmpty(true);
    setSkill(null);
    setResearch(false);
  }, [editor, isStreaming, onSend, pending, skill, research]);
  submitRef.current = submit;

  useImperativeHandle(
    ref,
    () => ({
      prefill: (text: string) => {
        if (!editor || editor.isDestroyed) return;
        editor.commands.setContent(`<p>${text}</p>`);
        editor.commands.focus("end");
        setEmpty(!text.trim());
      },
      focus: () => editor?.commands.focus("end"),
    }),
    [editor],
  );

  useEffect(() => {
    if (autofocus && editor && !editor.isDestroyed) editor.commands.focus("end");
  }, [editor, autofocus]);

  const canSend = (!empty || pending.some((p) => !p.uploading)) && !(research && empty);
  const chips = (contextPages?.length ?? 0) + pending.length > 0 || Boolean(skill) || research;

  return (
    <div className={variant === "flat" ? classes.flat : classes.card} data-chat-input>
      <input
        ref={fileInputRef}
        type="file"
        accept={CHAT_ACCEPTED_FILES}
        multiple
        tabIndex={-1}
        aria-label={t("Add files")}
        style={{ display: "none" }}
        onChange={(e) => addFiles(e.target.files)}
      />
      {skillsOpen && (
        <SkillPicker
          skills={skills.data?.items ?? []}
          onPick={(s) => {
            setSkill(s);
            setSkillsOpen(false);
            editor?.commands.focus("end");
          }}
          onClose={() => {
            setSkillsOpen(false);
            editor?.commands.focus("end");
          }}
        />
      )}
      {chips && (
        <div className={classes.chips}>
          {research && (
            <span className={classes.chip} data-testid="research-chip">
              <IconTelescope size={14} />
              <span className={classes.chipName}>{t("Research")}</span>
              <button type="button" className={classes.chipRemove} onClick={() => setResearch(false)} aria-label={t("Turn off research mode")}>
                <IconX size={12} />
              </button>
            </span>
          )}
          {skill && (
            <span className={classes.chip} data-testid="skill-chip">
              <IconSparkles size={14} />
              <span className={classes.chipName}>{skill.name}</span>
              <button type="button" className={classes.chipRemove} onClick={() => setSkill(null)} aria-label={t("Remove {{name}}", { name: skill.name })}>
                <IconX size={12} />
              </button>
            </span>
          )}
          {contextPages?.map((page) => (
            <span key={page.id} className={classes.chip}>
              <IconFileText size={14} />
              <span className={classes.chipName}>{page.title || t("Untitled")}</span>
              {onRemoveContextPage && (
                <button
                  type="button"
                  className={classes.chipRemove}
                  onClick={() => onRemoveContextPage(page.id)}
                  aria-label={t("Remove {{name}}", { name: page.title })}
                >
                  <IconX size={12} />
                </button>
              )}
            </span>
          ))}
          {pending.map((file) => (
            <span key={file.id} className={classes.chip} data-uploading={file.uploading || undefined}>
              {CHAT_IMAGE_EXTENSIONS.includes(file.fileExt) ? <IconPhoto size={14} /> : <IconFile size={14} />}
              <span className={classes.chipName}>{file.fileName}</span>
              {!file.uploading && (
                <button
                  type="button"
                  className={classes.chipRemove}
                  onClick={() => setPending((prev) => prev.filter((p) => p.id !== file.id))}
                  aria-label={t("Remove {{name}}", { name: file.fileName })}
                >
                  <IconX size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <EditorContent editor={editor} className={classes.editor} />

      <div className={classes.actions}>
        <Menu position="top-start" width={200} shadow="md">
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" radius="xl" aria-label={t("Add")}>
              <IconPlus size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconPaperclip size={16} />}
              disabled={pending.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => fileInputRef.current?.click()}
            >
              {t("Add files")}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconAt size={16} />}
              onClick={() => {
                editor?.commands.insertContent("@");
                editor?.commands.focus();
              }}
            >
              {t("Mention a page")}
            </Menu.Item>
            <Menu.Item leftSection={<IconSparkles size={16} />} onClick={() => setSkillsOpen(true)} data-testid="pick-skill">
              {t("Use a skill")}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconTelescope size={16} />}
              rightSection={research ? <IconCheck size={14} /> : undefined}
              onClick={() => setResearch((r) => !r)}
              data-testid="toggle-research"
            >
              {t("Research mode")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <div className={classes.spacer} />
        {isStreaming ? (
          <Tooltip label={t("Stop")}>
            <ActionIcon variant="filled" color="dark" radius="xl" onClick={onStop} aria-label={t("Stop")}>
              <IconPlayerStopFilled size={14} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <ActionIcon variant="filled" radius="xl" onClick={submit} disabled={!canSend} aria-label={t("Send")}>
            <IconArrowUp size={16} stroke={2.5} />
          </ActionIcon>
        )}
      </div>
    </div>
  );
});

// The skills this person may run, searchable; whole rows are buttons.
function SkillPicker({ skills, onPick, onClose }: { skills: ISkill[]; onPick: (skill: ISkill) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = skills.filter((s) => !query || `${s.name} ${s.description ?? ""} ${s.slug}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className={chatClasses.skillPanel} role="dialog" aria-label={t("Skills")} data-testid="skill-picker">
      <TextInput
        size="xs"
        autoFocus
        placeholder={t("Search skills")}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && shown[active]) onPick(shown[active]);
        }}
      />
      <div className={chatClasses.skillList} role="listbox">
        {shown.length === 0 && (
          <span className={chatClasses.skillRow} style={{ cursor: "default" }}>
            <small>{skills.length ? t("No skill matches") : t("No skills yet. Add them under Settings.")}</small>
          </span>
        )}
        {shown.map((s, i) => (
          <button key={s.id} type="button" role="option" aria-selected={i === active} className={chatClasses.skillRow} data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => onPick(s)}>
            <span>{s.name}</span>
            {s.description && <small>{s.description}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ChatInput;
