import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "@/lib/api-error";
import { startResearch } from "@/features/ai/research/services";
import { AI_CHATS_KEY, aiChatKey } from "../queries";
import { approveChatTool, ChatStreamHandlers, denyChatTool, getChatInfo, sendChatMessage } from "../services";
import { AiChatMessage, AiChatToolCall, ChatAttachment, PageMention, SendExtras } from "../types";

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

  // Pull the chat again from the server (a research report finished).
  const refresh = useCallback(async () => {
    const id = chatIdRef.current;
    if (!id) return;
    try {
      const info = await getChatInfo(id);
      setMessages(info.messages);
      queryClient.invalidateQueries({ queryKey: aiChatKey(id) });
      queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY });
    } catch {
      /* the next load shows it */
    }
  }, [queryClient]);

  const adoptChat = useCallback(
    (id: string) => {
      chatIdRef.current = id;
      ownedChatIdRef.current = id;
      if (options?.onChatCreated) options.onChatCreated(id);
      else navigate(`/ai/chat/${id}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY });
    },
    [navigate, options, queryClient],
  );

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

  // One streamed turn, whatever request started it.
  const runStream = useCallback(
    (start: (handlers: ChatStreamHandlers) => AbortController) => {
      setError(null);
      setIsStreaming(true);
      liveRef.current = { content: "", toolCalls: [] };
      setStreamingContent("");
      setStreamingToolCalls([]);
      abortRef.current = start({
        onEvent: (event) => {
          switch (event.type) {
            case "chat_created":
              adoptChat(event.chatId);
              break;
            case "content":
              liveRef.current.content += event.text;
              setStreamingContent(liveRef.current.content);
              break;
            case "tool_call":
              liveRef.current.toolCalls = [...liveRef.current.toolCalls, { id: event.id, name: event.name, args: event.args }];
              setStreamingToolCalls(liveRef.current.toolCalls);
              break;
            case "tool_result":
              liveRef.current.toolCalls = liveRef.current.toolCalls.map((tc) => (tc.id === event.id ? { ...tc, result: event.result } : tc));
              setStreamingToolCalls(liveRef.current.toolCalls);
              break;
            case "done":
              finishWith({ id: event.messageId, metadata: event.usage ? { tokenUsage: event.usage } : null });
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
      });
    },
    [adoptChat, finishWith, queryClient],
  );

  const pushUser = useCallback((content: string, metadata: Record<string, unknown>) => {
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
  }, []);

  const send = useCallback(
    (content: string, mentions: PageMention[] = [], attachments: ChatAttachment[] = [], contextPageId?: string, extras?: SendExtras) => {
      if (isStreaming || (!content.trim() && attachments.length === 0)) return;
      const metadata: Record<string, unknown> = {};
      if (mentions.length) metadata.mentionedPageIds = mentions.map((m) => m.id);
      if (attachments.length) metadata.attachments = attachments.map((a) => ({ id: a.id, fileName: a.fileName, fileExt: a.fileExt }));
      if (extras?.skillId) metadata.skill = { id: extras.skillId, name: extras.skillName ?? "" };

      if (extras?.research) {
        // Research runs on the server queue; the thread shows its progress
        // under the question and reloads when the report lands.
        setError(null);
        void (async () => {
          try {
            const report = await startResearch({ question: content, chatId: chatIdRef.current });
            if (!chatIdRef.current && report.chatId) adoptChat(report.chatId);
            pushUser(content, { ...metadata, research: { reportId: report.id } });
          } catch (err) {
            setError(getApiErrorMessage(err, "Could not start the research"));
          }
        })();
        return;
      }

      pushUser(content, metadata);
      runStream((handlers) =>
        sendChatMessage(
          {
            chatId: chatIdRef.current,
            content,
            mentionedPageIds: mentions.map((m) => m.id),
            contextPageId,
            attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
            skillId: extras?.skillId,
          },
          handlers,
        ),
      );
    },
    [isStreaming, adoptChat, pushUser, runStream],
  );

  const decide = useCallback(
    (approvalId: string, decision: "approved" | "denied", tool: string, server: string) => {
      if (isStreaming) return;
      pushUser("", { kind: "tool_approval", approvalId, decision, tool, server });
      runStream((handlers) => (decision === "approved" ? approveChatTool(approvalId, handlers) : denyChatTool(approvalId, handlers)));
    },
    [isStreaming, pushUser, runStream],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    finishWith({ id: `stopped-${Date.now()}` });
  }, [finishWith]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, streamingContent, streamingToolCalls, isStreaming, error, send, stop, hydrate, decide, refresh };
}
