import { useEffect, useMemo, useState } from "react";
import { NodeViewProps, NodeViewWrapper, useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { ActionIcon, Button, Group, NumberInput, Text, Textarea, Tooltip } from "@mantine/core";
import { IconCode, IconEye } from "@tabler/icons-react";
import { htmlBlockSrcDoc, HTML_BLOCK_MAX_CHARS } from "@docmost/editor-ext";
import classes from "./html-block.module.css";

type Attrs = { html: string; height: number; title: string | null };

const STARTER = `<style>
  .box { padding: 16px; border-radius: 8px; background: #eef3ff; font-family: system-ui, sans-serif; }
  button { padding: 6px 12px; border-radius: 6px; border: 1px solid #4c6ef5; background: #4c6ef5; color: white; cursor: pointer; }
</style>
<div class="box">
  <p>Clicked <strong id="n">0</strong> times.</p>
  <button id="b">Click me</button>
</div>
<script>
  let n = 0;
  document.getElementById('b').addEventListener('click', () => {
    n += 1;
    document.getElementById('n').textContent = String(n);
  });
</script>`;

// An HTML block: a sandboxed frame (scripts yes, same-origin no) showing the
// stored markup; editors flip to the code and back.
export default function HtmlBlockView({ node, editor, updateAttributes, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const attrs = node.attrs as Attrs;
  const isEditable = useEditorState({ editor, selector: ({ editor }) => editor?.isEditable ?? false });
  const [editing, setEditing] = useState(isEditable && !attrs.html);
  const [draft, setDraft] = useState(attrs.html || STARTER);
  const [height, setHeight] = useState<number>(attrs.height || 320);
  useEffect(() => {
    if (!editing) setDraft(attrs.html || STARTER);
  }, [attrs.html, editing]);
  const srcDoc = useMemo(() => htmlBlockSrcDoc(attrs.html), [attrs.html]);

  const apply = () => {
    updateAttributes({ html: draft.slice(0, HTML_BLOCK_MAX_CHARS), height: Math.max(80, Math.min(2000, Number(height) || 320)) });
    setEditing(false);
  };

  return (
    <NodeViewWrapper data-type="html-block" className={classes.wrap} data-selected={selected || undefined}>
      {isEditable && (
        <div className={classes.bar} contentEditable={false}>
          <Text size="xs" c="dimmed">
            {t("HTML block")} · {t("runs in a sandbox: no access to the wiki, cookies or network")}
          </Text>
          <Group gap={4} wrap="nowrap">
            {editing ? (
              <>
                <NumberInput size="xs" w={90} min={80} max={2000} value={height} onChange={(v) => setHeight(Number(v) || 320)} aria-label={t("Height in pixels")} />
                <Button size="compact-xs" onClick={apply} data-testid="html-block-apply">
                  {t("Show")}
                </Button>
              </>
            ) : (
              <Tooltip label={t("Edit the code")}>
                <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setEditing(true)} aria-label={t("Edit the code")} data-testid="html-block-edit">
                  <IconCode size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </div>
      )}
      {editing && isEditable ? (
        <Textarea
          className={classes.code}
          autosize
          minRows={8}
          maxRows={30}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          styles={{ input: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 } }}
          placeholder="<div>…</div>"
          data-testid="html-block-code"
        />
      ) : attrs.html ? (
        <iframe
          className={classes.frame}
          title={attrs.title || t("HTML block")}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          style={{ height: attrs.height || 320 }}
        />
      ) : (
        <div className={classes.empty}>
          <IconEye size={16} />
          <Text size="sm" c="dimmed">
            {t("Empty HTML block")}
          </Text>
        </div>
      )}
    </NodeViewWrapper>
  );
}
