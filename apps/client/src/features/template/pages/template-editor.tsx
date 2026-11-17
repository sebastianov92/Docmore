import "@/features/editor/styles/index.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Container, Group, Popover, Stack, Text } from "@mantine/core";
import { IconArrowLeft, IconCheck, IconMoodSmile, IconSettings } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useAtomValue } from "jotai";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor } from "@tiptap/react";
import EmojiPicker from "@/components/ui/emoji-picker";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { templateExtensions } from "@/features/editor/extensions/extensions";
import { FixedToolbar } from "@/features/editor/components/fixed-toolbar/fixed-toolbar";
import { EditorBubbleMenu } from "@/features/editor/components/bubble-menu/bubble-menu";
import { EditorLinkMenu } from "@/features/editor/components/link/link-menu";
import TableMenu from "@/features/editor/components/table/table-menu.tsx";
import { TableHandlesLayer } from "@/features/editor/components/table/handle/table-handles-layer";
import CalloutMenu from "@/features/editor/components/callout/callout-menu.tsx";
import ColumnsMenu from "@/features/editor/components/columns/columns-menu.tsx";
import { useGetSpacesQuery, useUnlistedSpaceQuery } from "@/features/space/queries/space-query";
import { includeSpace } from "@/features/space/space.utils";
import {
  useTemplateQuery,
  useUpdateTemplateMutation,
} from "@/features/template/queries/template-query.ts";
import { TemplateMeta } from "@/features/template/components/template-meta.tsx";
import { TemplateScopeSelect } from "@/features/template/components/template-scope-select.tsx";
import classes from "./template-editor.module.css";

const AUTOSAVE_DELAY_MS = 1500;

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export default function TemplateEditor() {
  const { t } = useTranslation();
  const { templateId } = useParams<{ templateId: string }>();
  const user = useAtomValue(userAtom);
  const toolbarEnabled = user?.settings?.preferences?.editorToolbar ?? false;

  const { data: template } = useTemplateQuery(templateId);
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const updateMutation = useUpdateTemplateMutation();

  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [draftSpaceId, setDraftSpaceId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [scopeOpened, { open: openScope, close: closeScope }] = useDisclosure(false);

  const { data: templateSpace } = useUnlistedSpaceQuery(spaceId, spaces?.items);
  const scopeSpaces = includeSpace(spaces?.items ?? [], templateSpace);

  // Refs keep the latest values for the debounced and unmount saves.
  const latest = useRef({ title: "", icon: null as string | null, spaceId: null as string | null });
  const loaded = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useRef<() => Promise<void>>(async () => undefined);

  const editor = useEditor({
    extensions: templateExtensions,
    content: "",
    textDirection: "auto",
    editorProps: {
      scrollThreshold: 80,
      scrollMargin: 80,
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
            if (document.querySelector("#slash-command")) return true;
          }
        },
      },
    },
    onUpdate() {
      if (loaded.current) markDirty();
    },
  });

  save.current = async () => {
    if (!editor || editor.isDestroyed || !templateId || !dirty.current) return;
    if (!latest.current.title.trim()) return;
    dirty.current = false;
    setStatus("saving");
    try {
      await updateMutation.mutateAsync({
        templateId,
        title: latest.current.title.trim(),
        icon: latest.current.icon,
        spaceId: latest.current.spaceId,
        content: editor.getJSON(),
      });
      if (dirty.current) return; // changed again while saving
      setStatus("saved");
      if (fade.current) clearTimeout(fade.current);
      fade.current = setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch {
      dirty.current = true;
      setStatus("error");
    }
  };

  const markDirty = useCallback(() => {
    dirty.current = true;
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.current(), AUTOSAVE_DELAY_MS);
  }, []);

  // Put the stored template into the editor once.
  useEffect(() => {
    if (!template || !editor || editor.isDestroyed) return;
    loaded.current = false;
    latest.current = {
      title: template.title ?? "",
      icon: template.icon ?? null,
      spaceId: template.spaceId ?? null,
    };
    setTitle(latest.current.title);
    setIcon(latest.current.icon);
    setSpaceId(latest.current.spaceId);
    editor.commands.setContent(template.content ?? "");
    requestAnimationFrame(() => {
      loaded.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id, editor]);

  // Save pending changes when leaving the page or the tab.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        save.current();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (timer.current) clearTimeout(timer.current);
      if (fade.current) clearTimeout(fade.current);
      if (dirty.current) save.current();
    };
  }, []);

  const changeTitle = (value: string) => {
    setTitle(value);
    latest.current.title = value;
    if (loaded.current) markDirty();
  };

  const changeIcon = (value: string | null) => {
    setIcon(value);
    latest.current.icon = value;
    if (loaded.current) markDirty();
  };

  const applyScope = () => {
    closeScope();
    if (draftSpaceId === spaceId) return;
    setSpaceId(draftSpaceId);
    latest.current.spaceId = draftSpaceId;
    markDirty();
  };

  return (
    <>
      <DocumentTitle title={title || t("Template")} />

      {toolbarEnabled && editor && <FixedToolbar editor={editor} templateMode />}

      <div className={classes.header}>
        <Container size={900} h="100%" px={0}>
          <Group justify="space-between" h="100%" wrap="nowrap">
            <Link to="/templates" className={classes.backLink}>
              <IconArrowLeft size={16} />
              {t("Templates")}
            </Link>

            <Group gap="sm" wrap="nowrap">
              {status === "saving" && (
                <Text size="xs" c="dimmed">
                  {t("Saving")}
                </Text>
              )}
              {status === "saved" && (
                <Group gap={4} wrap="nowrap">
                  <IconCheck size={14} color="var(--mantine-color-green-6)" />
                  <Text size="xs" c="dimmed">
                    {t("Saved")}
                  </Text>
                </Group>
              )}
              {status === "error" && (
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => save.current()}>
                  {t("Save failed. Retry")}
                </Button>
              )}

              <Popover
                width={320}
                position="bottom-end"
                shadow="md"
                opened={scopeOpened}
                onDismiss={closeScope}
              >
                <Popover.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={t("Template settings")}
                    onClick={() => {
                      setDraftSpaceId(spaceId);
                      openScope();
                    }}
                  >
                    <IconSettings size={18} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Stack gap="sm">
                    <TemplateScopeSelect
                      spaces={scopeSpaces}
                      value={draftSpaceId}
                      onChange={setDraftSpaceId}
                      size="sm"
                      comboboxProps={{ withinPortal: false }}
                    />
                    <Group justify="flex-end">
                      <Button variant="default" size="xs" onClick={closeScope}>
                        {t("Cancel")}
                      </Button>
                      <Button size="xs" onClick={applyScope}>
                        {t("Apply")}
                      </Button>
                    </Group>
                  </Stack>
                </Popover.Dropdown>
              </Popover>
            </Group>
          </Group>
        </Container>
      </div>

      <Container size={900} className={classes.body}>
        <div className={classes.titleArea}>
          <div className={classes.iconButton}>
            <EmojiPicker
              onEmojiSelect={(emoji: { native: string }) => changeIcon(emoji.native)}
              icon={icon ? <span className={classes.icon}>{icon}</span> : <IconMoodSmile size={20} stroke={1.5} />}
              removeEmojiAction={() => changeIcon(null)}
              readOnly={false}
              actionIconProps={icon ? { size: "3rem", variant: "transparent" } : undefined}
            />
          </div>
          <input
            className={classes.titleInput}
            placeholder={t("Untitled")}
            aria-label={t("Template title")}
            value={title}
            onChange={(event) => changeTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                editor?.commands.focus("start");
              }
            }}
          />
          {template && <TemplateMeta template={template} />}
        </div>

        <EditorContent editor={editor} />
        {editor && (
          <>
            <EditorBubbleMenu editor={editor} templateMode />
            <EditorLinkMenu editor={editor} />
            <TableMenu editor={editor} />
            <TableHandlesLayer editor={editor} />
            <CalloutMenu editor={editor} />
            <ColumnsMenu editor={editor} />
          </>
        )}
        <div
          style={{ paddingBottom: "20vh" }}
          onClick={() => editor?.commands.focus("end")}
        />
      </Container>
    </>
  );
}
