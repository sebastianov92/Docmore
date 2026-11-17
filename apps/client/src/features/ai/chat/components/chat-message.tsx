import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { Typography } from "@mantine/core";
import { IconFile, IconLoader2, IconPhoto } from "@tabler/icons-react";
import { markdownToHtml } from "@docmost/editor-ext";
import CopyTextButton from "@/components/common/copy.tsx";
import { AiChatMessage, AiChatToolCall, CHAT_IMAGE_EXTENSIONS, REFERENCED_PAGES_RE } from "../types";
import { ChatToolSteps } from "./chat-tool-steps";
import classes from "./chat.module.css";

const PAGE_PATH = /\/(?:s\/[^/?#\s]+\/)?p\/[^/?#\s]+/;

// Links to pages stay in-app whatever host the model invented around them;
// everything else opens in a new tab.
const sanitizer = DOMPurify();
sanitizer.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") ?? "";
  const match = href.match(PAGE_PATH);
  if (match) {
    node.setAttribute("href", match[0]);
    node.removeAttribute("target");
    node.removeAttribute("rel");
    return;
  }
  if (/^https?:\/\//.test(href)) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

interface Props {
  message: AiChatMessage;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingToolCalls?: AiChatToolCall[];
}

export function ChatMessage({ message, isStreaming, streamingContent, streamingToolCalls }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const content = isStreaming ? streamingContent ?? "" : message.content ?? "";
  const toolCalls = (isStreaming ? streamingToolCalls : message.toolCalls) ?? [];

  const html = useMemo(() => {
    if (message.role === "user" || !content) return "";
    return sanitizer.sanitize(markdownToHtml(content) as string, { ADD_ATTR: ["target", "rel"] });
  }, [content, message.role]);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const href = anchor?.getAttribute("href");
      if (href && (href.startsWith("/s/") || href.startsWith("/p/"))) {
        event.preventDefault();
        navigate(href);
      }
    },
    [navigate],
  );

  if (message.role === "tool") return null;

  if (message.role === "user") {
    const attachments = (message.metadata?.attachments as { id: string; fileName: string; fileExt: string }[]) ?? [];
    return (
      <div className={classes.userRow} role="article" aria-label={t("You said:")}>
        <div className={classes.userBubble}>
          {attachments.length > 0 && (
            <div className={classes.attachments}>
              {attachments.map((a) => (
                <span key={a.id} className={classes.attachment}>
                  {CHAT_IMAGE_EXTENSIONS.includes(a.fileExt) ? <IconPhoto size={13} /> : <IconFile size={13} />}
                  {a.fileName}
                </span>
              ))}
            </div>
          )}
          {content.replace(REFERENCED_PAGES_RE, "")}
        </div>
      </div>
    );
  }

  const failed = typeof message.metadata?.error === "string" ? (message.metadata.error as string) : null;

  return (
    <div className={classes.assistantRow} role="article" aria-label={content ? t("Assistant said:") : undefined}>
      <div className={classes.assistantBody}>
        {toolCalls.length > 0 && <ChatToolSteps toolCalls={toolCalls} isStreaming={isStreaming} />}
        {html && (
          <Typography className={classes.markdown}>
            <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          </Typography>
        )}
        {failed && <div className={classes.failed}>{failed}</div>}
        {isStreaming && !content && (
          <span className={classes.thinking}>
            <IconLoader2 size={15} className={classes.spin} />
            {t("Thinking…")}
          </span>
        )}
        {isStreaming && content && <span className={classes.cursor} aria-hidden />}
      </div>
      {!isStreaming && message.content && (
        <div className={classes.assistantActions}>
          <CopyTextButton text={message.content} label={t("Copy answer")} />
        </div>
      )}
    </div>
  );
}
