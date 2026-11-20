import { useEffect, useState } from "react";
import { NodeViewProps, NodeViewWrapper, useEditorState } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Button, Text, TextInput } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useUnfurl } from "@/features/editor/components/integration-link/use-unfurl";
import classes from "./bookmark.module.css";

type Attrs = { url: string; title: string | null; description: string | null; image: string | null; siteName: string | null; favicon: string | null };

// A bookmark card; the first editor to see it fills the metadata from the
// server's unfurl and stores it in the document.
export default function BookmarkView({ node, editor, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  const attrs = node.attrs as Attrs;
  const isEditable = useEditorState({ editor, selector: ({ editor }) => editor?.isEditable ?? false });
  const [draft, setDraft] = useState("");
  const needsMeta = Boolean(attrs.url) && !attrs.title;
  const unfurl = useUnfurl(needsMeta ? attrs.url : "");

  useEffect(() => {
    if (!needsMeta || !isEditable || unfurl.state !== "loaded") return;
    const d = unfurl.data;
    updateAttributes({
      title: d.title || attrs.url,
      description: d.description ?? null,
      image: d.metadata?.image ?? null,
      siteName: d.metadata?.siteName ?? null,
      favicon: d.metadata?.favicon ?? null,
    });
  }, [needsMeta, isEditable, unfurl, attrs.url, updateAttributes]);

  // the url only, when the server had nothing to say
  useEffect(() => {
    if (needsMeta && isEditable && unfurl.state === "error") updateAttributes({ title: attrs.url });
  }, [needsMeta, isEditable, unfurl.state, attrs.url, updateAttributes]);

  if (!attrs.url) {
    if (!isEditable) return <NodeViewWrapper data-type="bookmark" />;
    const add = () => {
      const url = draft.trim();
      if (!/^https?:\/\//i.test(url)) return;
      updateAttributes({ url });
    };
    return (
      <NodeViewWrapper data-type="bookmark" data-drag-handle>
        <div className={classes.empty} contentEditable={false}>
          <IconLink size={16} />
          <TextInput size="xs" style={{ flex: 1 }} placeholder={t("Paste a web address")} value={draft} onChange={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} autoFocus />
          <Button size="xs" onClick={add} disabled={!/^https?:\/\//i.test(draft.trim())}>
            {t("Add bookmark")}
          </Button>
        </div>
      </NodeViewWrapper>
    );
  }

  let hostname = "";
  try {
    hostname = new URL(attrs.url).hostname.replace(/^www\./, "");
  } catch {
    hostname = attrs.url;
  }
  const loading = needsMeta && unfurl.state === "loading";
  return (
    <NodeViewWrapper data-type="bookmark" data-drag-handle>
      <a className={classes.card} href={attrs.url} target="_blank" rel="noopener noreferrer" contentEditable={false} data-testid="bookmark-card">
        <div className={classes.text}>
          <Text fw={500} size="sm" lineClamp={1}>
            {loading ? t("Loading…") : attrs.title || attrs.url}
          </Text>
          {attrs.description && (
            <Text size="xs" c="dimmed" lineClamp={2}>
              {attrs.description}
            </Text>
          )}
          <div className={classes.site}>
            {attrs.favicon && <img className={classes.favicon} src={attrs.favicon} alt="" />}
            <Text size="xs" c="dimmed" truncate>
              {attrs.siteName || hostname} · {attrs.url}
            </Text>
          </div>
        </div>
        {attrs.image && <img className={classes.thumb} src={attrs.image} alt="" />}
      </a>
    </NodeViewWrapper>
  );
}
