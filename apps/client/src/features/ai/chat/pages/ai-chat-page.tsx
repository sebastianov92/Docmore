import { useEffect, useRef } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { useChatInfoQuery } from "../queries";
import { useChatStream } from "../hooks/use-chat-stream";
import { ChatThread } from "../components/chat-thread";
import { ChatEmptyState } from "../components/chat-empty-state";
import ChatInput from "../components/chat-input";
import { ChatAttachment, PageMention } from "../types";
import classes from "../components/chat.module.css";

export interface ChatPageState {
  initialContent?: string;
  initialMentions?: PageMention[];
  initialAttachments?: ChatAttachment[];
}

// /ai and /ai/chat/:chatId. The home prompt lands here with its first
// message in the router state and it is sent at once.
export default function AiChatPage() {
  const { t } = useTranslation();
  const { chatId } = useParams<{ chatId: string }>();
  return (
    <div className={classes.page}>
      <DocumentTitle title={t("AI chat")} />
      <ErrorBoundary
        resetKeys={[chatId]}
        fallbackRender={({ resetErrorBoundary }) => (
          <EmptyState
            icon={IconAlertTriangle}
            title={t("The chat could not be shown.")}
            action={
              <Button variant="default" size="sm" mt="xs" onClick={resetErrorBoundary}>
                {t("Try again")}
              </Button>
            }
          />
        )}
      >
        <Conversation chatId={chatId} />
      </ErrorBoundary>
    </div>
  );
}

function Conversation({ chatId }: { chatId: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const info = useChatInfoQuery(chatId);
  const chat = useChatStream(chatId);
  const sentInitialRef = useRef(false);

  useEffect(() => {
    if (info.data?.messages) chat.hydrate(info.data.messages);
  }, [info.data, chat.hydrate]);

  // A chat that is not this user's, or is gone, bounces to a new one.
  useEffect(() => {
    if (chatId && info.isError) navigate("/ai", { replace: true });
  }, [chatId, info.isError, navigate]);

  useEffect(() => {
    if (sentInitialRef.current || chatId) return;
    const state = location.state as ChatPageState | null;
    if (!state?.initialContent && !state?.initialAttachments?.length) return;
    sentInitialRef.current = true;
    chat.send(state.initialContent ?? "", state.initialMentions ?? [], state.initialAttachments ?? []);
    navigate(location.pathname, { replace: true, state: null });
  }, [chatId, location, navigate, chat.send]);

  if (chatId && info.isError) return null;

  const started = chat.messages.length > 0 || chat.isStreaming || Boolean(chatId);
  if (!started) {
    return (
      <ChatEmptyState
        isStreaming={chat.isStreaming}
        onSend={(content, mentions, attachments, extras) => chat.send(content, mentions, attachments, undefined, extras)}
        onStop={chat.stop}
      />
    );
  }

  return (
    <div className={classes.main}>
      <ChatThread
        messages={chat.messages}
        isStreaming={chat.isStreaming}
        streamingContent={chat.streamingContent}
        streamingToolCalls={chat.streamingToolCalls}
        onDecide={chat.decide}
        onResearchDone={chat.refresh}
      />
      {chat.error && <div className={classes.error}>{chat.error}</div>}
      <div className={classes.inputArea}>
        <ChatInput
          isStreaming={chat.isStreaming}
          onSend={(content, mentions, attachments, extras) => chat.send(content, mentions, attachments, undefined, extras)}
          onStop={chat.stop}
          chatId={chatId}
        />
        <div className={classes.disclaimer}>{t("Answers come from the pages you can read; check anything that matters.")}</div>
      </div>
    </div>
  );
}
