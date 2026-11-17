import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import { AiChat, AiChatMessage, AiChatStreamEvent, ChatAttachment, SendChatParams } from "./types";

export async function createChat(): Promise<AiChat> {
  const req = await api.post<AiChat>("/ai/chats/create");
  return req.data;
}

export async function listChats(params?: { limit?: number; cursor?: string }): Promise<IPagination<AiChat>> {
  const req = await api.post<IPagination<AiChat>>("/ai/chats", params ?? {});
  return req.data;
}

export async function getChatInfo(chatId: string): Promise<{ chat: AiChat; messages: AiChatMessage[] }> {
  const req = await api.post("/ai/chats/info", { chatId });
  return req.data;
}

export async function deleteChat(chatId: string): Promise<void> {
  await api.post("/ai/chats/delete", { chatId });
}

export async function renameChat(chatId: string, title: string): Promise<AiChat> {
  const req = await api.post<AiChat>("/ai/chats/update", { chatId, title });
  return req.data;
}

export async function searchChats(query: string): Promise<AiChat[]> {
  const req = await api.post<AiChat[]>("/ai/chats/search", { query });
  return req.data;
}

export async function uploadChatFile(file: File, chatId?: string): Promise<ChatAttachment> {
  const form = new FormData();
  form.append("file", file);
  if (chatId) form.append("chatId", chatId);
  const req = await api.post<ChatAttachment>("/ai/chats/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return req.data;
}

export interface ChatStreamHandlers {
  onEvent: (event: AiChatStreamEvent) => void;
  onError: (message: string) => void;
  onComplete: () => void;
}

// One message in, a stream of typed events out, over fetch so it can be
// aborted. Returns the controller that stops it.
export function sendChatMessage(params: SendChatParams, handlers: ChatStreamHandlers): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch("/api/ai/chats/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let message = `The chat request failed (${response.status})`;
        try {
          const payload = await response.json();
          message = payload?.message ?? message;
        } catch {
          /* keep the status text */
        }
        handlers.onError(message);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            handlers.onComplete();
            return;
          }
          try {
            handlers.onEvent(JSON.parse(payload) as AiChatStreamEvent);
          } catch {
            /* partial or malformed line: skip */
          }
        }
      }
      handlers.onComplete();
    } catch (err: any) {
      if (err?.name === "AbortError") {
        handlers.onComplete();
        return;
      }
      handlers.onError(err?.message ?? "The chat request failed");
    }
  })();
  return controller;
}
