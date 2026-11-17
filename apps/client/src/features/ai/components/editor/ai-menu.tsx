import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionIcon, Loader, TextInput, UnstyledButton } from "@mantine/core";
import { useDebouncedCallback, useMediaQuery } from "@mantine/hooks";
import { IconArrowUp, IconPlayerStop } from "@tabler/icons-react";
import { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import { useAtom } from "jotai";
import { marked } from "marked";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { copyToClipboard, htmlToMarkdown, isEditorReady } from "@docmost/editor-ext";
import { showAiMenuAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { streamGeneration } from "@/features/ai/services";
import { AiAction } from "@/features/ai/types";
import { AI_COMMANDS, AiCommand, CommandSet } from "./ai-commands";
import classes from "./ai-menu.module.css";

interface Props {
  editor: Editor | null;
}

// Floating "Ask AI" panel under the selection. Pick a command or type a
// request; the answer streams in, then it can replace the selection, be
// inserted below, copied or discarded.
export function EditorAiMenu({ editor }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useAtom(showAiMenuAtom);
  const location = useLocation();
  const narrow = useMediaQuery("(max-width: 48em)");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [set, setSet] = useState<CommandSet>("main");
  const [selected, setSelected] = useState(0);
  const [lastCommand, setLastCommand] = useState<AiCommand | null>(null);
  const [placement, setPlacement] = useState({ top: 0, left: 0, width: 0 });

  const items = useMemo(() => {
    const list = AI_COMMANDS[set];
    if (set !== "main" || !prompt) return list;
    return list.filter((c) => c.name.toLowerCase().includes(prompt.toLowerCase()));
  }, [set, prompt]);

  const place = useCallback(() => {
    if (!isEditorReady(editor) || !open) return;
    const { view, state } = editor;
    const rect = view.dom.getBoundingClientRect();
    const from = view.coordsAtPos(state.selection.from);
    const to = view.coordsAtPos(state.selection.to);
    const padding = narrow ? 16 : 48;
    const left = rect.left + padding;
    const right = rect.right - padding;
    const width = Math.min(600, right - left);
    let x = Math.max(left, from.left);
    if (x + width > right) x = right - width;
    const bottom = to.bottom > 0 && to.bottom < window.innerHeight ? to.bottom : from.bottom;
    setPlacement({ top: bottom + 8 + window.scrollY, left: Math.max(left, x) + window.scrollX, width });
  }, [editor, open, narrow]);
  const placeSoon = useDebouncedCallback(place, 60);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPrompt("");
    setOutput("");
    setError(null);
    setStreaming(false);
    setSet("main");
    setSelected(0);
    setLastCommand(null);
  }, []);

  const selectionMarkdown = useCallback(() => {
    if (!isEditorReady(editor)) return "";
    const { from, to } = editor.state.selection;
    const slice = editor.state.doc.slice(from, to);
    const serializer = DOMSerializer.fromSchema(editor.schema);
    const wrapper = document.createElement("div");
    wrapper.appendChild(serializer.serializeFragment(slice.content));
    return htmlToMarkdown(wrapper.innerHTML);
  }, [editor]);

  const run = useCallback(
    (command: AiCommand) => {
      if (!isEditorReady(editor) || streaming) return;
      abortRef.current?.abort();
      setOutput("");
      setError(null);
      setStreaming(true);
      setLastCommand(command);
      abortRef.current = streamGeneration(
        { action: command.action as AiAction, content: selectionMarkdown(), prompt: command.prompt },
        {
          onChunk: (text) => setOutput((prev) => prev + text),
          onDone: () => {
            setStreaming(false);
            setSet("result");
            setSelected(0);
            setPrompt("");
          },
          onError: (message) => {
            setStreaming(false);
            setError(message);
          },
        },
      );
    },
    [editor, streaming, selectionMarkdown],
  );

  const insertResult = useCallback(
    (mode: "replace" | "insert") => {
      if (!isEditorReady(editor) || !output) return setOpen(false);
      const html = (marked.parse(output) as string).trim();
      const single = html.startsWith("<p>") && html.endsWith("</p>") && html.lastIndexOf("<p>") === 0;
      // One paragraph goes in inline so it keeps the surrounding block; the
      // entities are decoded first or TipTap would show them literally.
      const content = single ? new DOMParser().parseFromString(html.slice(3, -4), "text/html").body.innerHTML : html;
      const chain = editor.chain().focus();
      if (mode === "insert" || lastCommand?.action === "continue_writing") {
        chain.setTextSelection(editor.state.selection.to);
      }
      chain.insertContent(content).run();
      setOpen(false);
    },
    [editor, output, lastCommand, setOpen],
  );

  const choose = useCallback(
    (command?: AiCommand) => {
      if (!command) {
        if (prompt.trim()) run({ id: "custom", name: "Custom", icon: AI_COMMANDS.main[0].icon, action: "custom", prompt: prompt.trim() });
        return;
      }
      switch (command.id) {
        case "replace":
          return insertResult("replace");
        case "insert":
          return insertResult("insert");
        case "copy":
          copyToClipboard(output);
          return setOpen(false);
        case "retry":
          return lastCommand && run(lastCommand);
        case "discard":
          return reset();
      }
      if (command.opens) {
        setSet(command.opens);
        setSelected(0);
        setPrompt("");
        return;
      }
      run(command);
    },
    [prompt, run, insertResult, output, lastCommand, reset, setOpen],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      return setOpen(false);
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => (items.length ? (i + delta + items.length) % items.length : 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (streaming) return;
      if (prompt.trim() && set === "main") return choose();
      choose(items[selected]);
    }
  };

  // Keep it anchored to the selection; close with the editor or on navigation.
  useEffect(() => {
    if (!isEditorReady(editor) || !open) return;
    place();
    const observer = new ResizeObserver(() => placeSoon());
    observer.observe(editor.view.dom);
    window.addEventListener("resize", placeSoon);
    window.addEventListener("scroll", placeSoon, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeSoon);
      window.removeEventListener("scroll", placeSoon, true);
    };
  }, [editor, open, place, placeSoon]);

  useEffect(() => setOpen(false), [location, setOpen]);
  useEffect(() => {
    if (open) reset();
    else abortRef.current?.abort();
  }, [open, reset]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [open, set, streaming]);
  useEffect(() => setSelected(0), [items.length, set]);

  if (!open) return null;

  const placeholder =
    set === "result"
      ? t("What next?")
      : set === "main"
        ? t("Ask AI to write or change the selection…")
        : t("Pick one");

  return createPortal(
    <div style={{ position: "absolute", top: placement.top, left: placement.left, width: placement.width, zIndex: 199 }}>
      <div className={classes.menu} role="dialog" aria-label={t("Ask AI")}>
        {(output || streaming) && (
          <div className={classes.preview}>
            {output}
            {streaming && <span className={classes.cursor} aria-hidden />}
          </div>
        )}
        {error && <div className={classes.error}>{error}</div>}
        <div className={classes.inputRow}>
          <TextInput
            ref={inputRef}
            className={classes.input}
            placeholder={placeholder}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            disabled={streaming}
            aria-label={t("Ask AI")}
            rightSection={
              streaming ? (
                <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => abortRef.current?.abort()} aria-label={t("Stop")}>
                  <IconPlayerStop size={14} />
                </ActionIcon>
              ) : (
                <ActionIcon
                  variant="filled"
                  radius="xl"
                  size="sm"
                  disabled={!prompt.trim()}
                  onClick={() => choose()}
                  aria-label={t("Send")}
                >
                  <IconArrowUp size={14} stroke={2.5} />
                </ActionIcon>
              )
            }
          />
        </div>
        {streaming ? (
          <div className={classes.list} style={{ display: "flex", justifyContent: "center", padding: 10 }}>
            <Loader size="xs" />
          </div>
        ) : (
          items.length > 0 && (
            <div className={classes.list} role="listbox">
              {items.map((item, index) => {
                const Icon = item.icon;
                return (
                  <UnstyledButton
                    key={item.id}
                    className={classes.item}
                    data-selected={index === selected || undefined}
                    role="option"
                    aria-selected={index === selected}
                    onMouseEnter={() => setSelected(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <Icon size={16} />
                    {t(item.name)}
                  </UnstyledButton>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>,
    document.body,
  );
}
