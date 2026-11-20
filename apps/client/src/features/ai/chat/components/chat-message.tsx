import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { Typography } from "@mantine/core";
import { IconFile, IconLoader2, IconPhoto, IconSparkles, IconTelescope } from "@tabler/icons-react";
import { markdownToHtml } from "@docmost/editor-ext";
import CopyTextButton from "@/components/common/copy.tsx";
import { AiChatMessage, AiChatToolCall, CHAT_IMAGE_EXTENSIONS, REFERENCED_PAGES_RE } from "../types";
import { ApprovalDecision, ChatToolSteps } from "./chat-tool-steps";
import { ResearchProgress } from "./research-progress";
import { ResearchSources } from "./research-sources";
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
  // the last message of the thread (a research question still running shows its progress)
  isLast?: boolean;
  decided?: Record<string, ApprovalDecision>;
  onDecide?: (approvalId: string, decision: ApprovalDecision, tool: string, server: string) => void;
  onResearchDone?: () => void;
}

export function ChatMessage({ message, isStreaming, streamingContent, streamingToolCalls, isLast, decided, onDecide, onResearchDone }: Props) {
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

  if (message.role === "user" && message.metadata?.kind === "tool_approval") {
    const decision = message.metadata.decision as string;
    return (
      <div className={classes.systemNote} role="note">
        {decision === "approved"
          ? t("You allowed {{tool}} on {{server}}", { tool: message.metadata.tool, server: message.metadata.server })
          : t("You declined {{tool}} on {{server}}", { tool: message.metadata.tool, server: message.metadata.server })}
      </div>
    );
  }

  if (message.role === "user") {
    const attachments = (message.metadata?.attachments as { id: string; fileName: string; fileExt: string }[]) ?? [];
    const skill = message.metadata?.skill as { id: string; name: string } | undefined;
    const research = message.metadata?.research as { reportId: string } | undefined;
    return (
      <>
      <div className={classes.userRow} role="article" aria-label={t("You said:")}>
        <div className={classes.userBubble}>
          {(skill || research) && (
            <div className={classes.userTags}>
              {research && (
                <span className={classes.userTag}>
                  <IconTelescope size={12} />
                  {t("Research")}
                </span>
              )}
              {skill && (
                <span className={classes.userTag}>
                  <IconSparkles size={12} />
                  {skill.name}
                </span>
              )}
            </div>
          )}
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
      {research && isLast && onResearchDone && <ResearchProgress reportId={research.reportId} onDone={onResearchDone} />}
      </>
    );
  }

  const research = message.metadata?.research as { reportId: string; sources?: { n: number; pageId: string; title: string; url: string }[] } | undefined;

  const failed = typeof message.metadata?.error === "string" ? (message.metadata.error as string) : null;

  return (
    <div className={classes.assistantRow} role="article" aria-label={content ? t("Assistant said:") : undefined}>
      <div className={classes.assistantBody}>
        {toolCalls.length > 0 && <ChatToolSteps toolCalls={toolCalls} isStreaming={isStreaming} decided={decided} onDecide={onDecide} />}
        {html && (
          <Typography className={classes.markdown}>
            <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          </Typography>
        )}
        {research?.sources && research.sources.length > 0 && <ResearchSources reportId={research.reportId} sources={research.sources} />}
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
