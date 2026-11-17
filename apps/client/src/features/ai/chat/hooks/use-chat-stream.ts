import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AI_CHATS_KEY, aiChatKey } from "../queries";
import { sendChatMessage } from "../services";
import { AiChatMessage, AiChatToolCall, ChatAttachment, PageMention } from "../types";

interface Options {
  // Called instead of navigating to /ai/chat/:id when the server creates
  // the chat for the first message (the aside panel keeps its own id).
  onChatCreated?: (chatId: string) => void;
}

// The live state of one conversation: the messages shown, the reply being
// streamed in, and the send/stop controls. Messages from the server are
// taken once per chat; after that the hook owns the list.
export function useChatStream(chatId: string | undefined, options?: Options) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<AiChatToolCall[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  // Which chat the local messages belong to; a chat this hook created keeps
  // its optimistic messages when the route catches up with the new id.
  const ownedChatIdRef = useRef<string | undefined>(undefined);
  const liveRef = useRef({ content: "", toolCalls: [] as AiChatToolCall[] });

  useEffect(() => {
    if (chatId && chatId === ownedChatIdRef.current) return;
    ownedChatIdRef.current = undefined;
    setMessages([]);
    setError(null);
  }, [chatId]);

  const hydrate = useCallback((serverMessages: AiChatMessage[]) => {
    const forChat = chatIdRef.current;
    if (!forChat || ownedChatIdRef.current === forChat) return;
    ownedChatIdRef.current = forChat;
    setMessages(serverMessages);
  }, []);

  const finishWith = useCallback((message: Partial<AiChatMessage> & { id: string }) => {
    const { content, toolCalls } = liveRef.current;
    if (content || toolCalls.length > 0 || message.content) {
      setMessages((prev) => [
        ...prev,
        {
          chatId: chatIdRef.current ?? "",
          role: "assistant",
          content: content || null,
          toolCalls: toolCalls.length ? toolCalls : null,
          metadata: null,
          createdAt: new Date().toISOString(),
          ...message,
        } as AiChatMessage,
      ]);
    }
    liveRef.current = { content: "", toolCalls: [] };
    setStreamingContent("");
    setStreamingToolCalls([]);
    setIsStreaming(false);
  }, []);

  const send = useCallback(
    (content: string, mentions: PageMention[] = [], attachments: ChatAttachment[] = [], contextPageId?: string) => {
      if (isStreaming || (!content.trim() && attachments.length === 0)) return;
      setError(null);
      setIsStreaming(true);
      liveRef.current = { content: "", toolCalls: [] };
      setStreamingContent("");
      setStreamingToolCalls([]);

      const metadata: Record<string, unknown> = {};
      if (mentions.length) metadata.mentionedPageIds = mentions.map((m) => m.id);
      if (attachments.length) {
        metadata.attachments = attachments.map((a) => ({ id: a.id, fileName: a.fileName, fileExt: a.fileExt }));
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          chatId: chatIdRef.current ?? "",
          role: "user",
          content,
          toolCalls: null,
          metadata: Object.keys(metadata).length ? metadata : null,
          createdAt: new Date().toISOString(),
        },
      ]);

      abortRef.current = sendChatMessage(
        {
          chatId: chatIdRef.current,
          content,
          mentionedPageIds: mentions.map((m) => m.id),
          contextPageId,
          attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
        },
        {
          onEvent: (event) => {
            switch (event.type) {
              case "chat_created":
                chatIdRef.current = event.chatId;
                ownedChatIdRef.current = event.chatId;
                if (options?.onChatCreated) options.onChatCreated(event.chatId);
                else navigate(`/ai/chat/${event.chatId}`, { replace: true });
                queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY });
                break;
              case "content":
                liveRef.current.content += event.text;
                setStreamingContent(liveRef.current.content);
                break;
              case "tool_call":
                liveRef.current.toolCalls = [
                  ...liveRef.current.toolCalls,
                  { id: event.id, name: event.name, args: event.args },
                ];
                setStreamingToolCalls(liveRef.current.toolCalls);
                break;
              case "tool_result":
                liveRef.current.toolCalls = liveRef.current.toolCalls.map((tc) =>
                  tc.id === event.id ? { ...tc, result: event.result } : tc,
                );
                setStreamingToolCalls(liveRef.current.toolCalls);
                break;
              case "done":
                finishWith({
                  id: event.messageId,
                  metadata: event.usage ? { tokenUsage: event.usage } : null,
                });
                queryClient.invalidateQueries({ queryKey: aiChatKey(chatIdRef.current) });
                queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY });
                break;
              case "error":
                setError(event.message);
                finishWith({ id: `failed-${Date.now()}` });
                break;
            }
          },
          onError: (message) => {
            setError(message);
            finishWith({ id: `failed-${Date.now()}` });
          },
          onComplete: () => {
            // A stream that ends without "done" (stopped, dropped) keeps
            // what arrived.
            setIsStreaming((still) => {
              if (still) finishWith({ id: `partial-${Date.now()}` });
              return false;
            });
          },
        },
      );
    },
    [isStreaming, navigate, options, queryClient, finishWith],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    finishWith({ id: `stopped-${Date.now()}` });
  }, [finishWith]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, streamingContent, streamingToolCalls, isStreaming, error, send, stop, hydrate };
}
