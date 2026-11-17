import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, VisuallyHidden } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AiChatMessage, AiChatToolCall } from "../types";
import { ChatMessage } from "./chat-message";
import classes from "./chat.module.css";

interface Props {
  messages: AiChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  streamingToolCalls: AiChatToolCall[];
  compact?: boolean;
}

const NEAR_BOTTOM_PX = 40;

// The transcript. Follows the stream while the reader is at the bottom and
// stays put, with a jump button, once they scroll up.
export function ChatThread({ messages, isStreaming, streamingContent, streamingToolCalls, compact }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [status, setStatus] = useState("");
  const wasStreamingRef = useRef(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      atBottomRef.current = distance <= NEAR_BOTTOM_PX;
      setShowJump(!atBottomRef.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (atBottomRef.current) scrollToBottom("instant");
  }, [streamingContent, streamingToolCalls.length, scrollToBottom]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "user" || atBottomRef.current) scrollToBottom("smooth");
  }, [messages, scrollToBottom]);

  // One polite announcement per turn instead of one per token.
  useEffect(() => {
    if (isStreaming && !wasStreamingRef.current) setStatus(t("Thinking…"));
    if (!isStreaming && wasStreamingRef.current) {
      const last = messages[messages.length - 1];
      setStatus(last?.role === "assistant" && last.content ? last.content.replace(/[#*_`~]/g, "") : "");
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, messages, t]);

  return (
    <div className={classes.threadWrap}>
      <VisuallyHidden role="status" aria-live="polite">
        {status}
      </VisuallyHidden>
      <div ref={containerRef} className={classes.thread} data-compact={compact || undefined} aria-label={t("Chat transcript")}>
        <div className={classes.threadInner}>
          {messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))}
          {isStreaming && (
            <ChatMessage
              message={{
                id: "streaming",
                chatId: "",
                role: "assistant",
                content: null,
                toolCalls: null,
                metadata: null,
                createdAt: new Date().toISOString(),
              }}
              isStreaming
              streamingContent={streamingContent}
              streamingToolCalls={streamingToolCalls}
            />
          )}
        </div>
      </div>
      {showJump && (
        <ActionIcon
          className={classes.jump}
          variant="default"
          radius="xl"
          size="lg"
          onClick={() => scrollToBottom("smooth")}
          aria-label={t("Scroll to bottom")}
        >
          <IconArrowDown size={16} />
        </ActionIcon>
      )}
    </div>
  );
}
