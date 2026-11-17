import api from "@/lib/api-client";
import {
  AiAnswerSource,
  AiAskParams,
  AiConfig,
  AiEmbeddingStatus,
  AiGenerateRequest,
  AiModelInfo,
  AiProviderId,
  AiSettingsView,
  UpdateAiSettings,
} from "./types";

export async function getAiConfig(): Promise<AiConfig> {
  const req = await api.post<AiConfig>("/ai/config", {});
  return req.data;
}

export async function getAiSettings(): Promise<AiSettingsView> {
  const req = await api.post<AiSettingsView>("/ai/settings", {});
  return req.data;
}

export async function updateAiSettings(data: UpdateAiSettings): Promise<AiSettingsView> {
  const req = await api.post<AiSettingsView>("/ai/settings/update", data);
  return req.data;
}

export async function listProviderModels(data: {
  provider: AiProviderId;
  apiKey?: string;
  baseUrl?: string;
}): Promise<AiModelInfo[]> {
  const req = await api.post<{ models: AiModelInfo[] }>("/ai/providers/models", data);
  return req.data.models;
}

export async function generateOnce(data: AiGenerateRequest): Promise<string> {
  const req = await api.post<{ content: string }>("/ai/generate", data);
  return req.data.content;
}

export async function getEmbeddingStatus(): Promise<AiEmbeddingStatus> {
  const req = await api.post<AiEmbeddingStatus>("/ai/embeddings/status", {});
  return req.data;
}

export async function reindexEmbeddings(): Promise<AiEmbeddingStatus> {
  const req = await api.post<AiEmbeddingStatus>("/ai/embeddings/reindex", {});
  return req.data;
}

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

// Ask AI in the editor: data: {"content"} chunks until [DONE].
export function streamGeneration(data: AiGenerateRequest, handlers: StreamHandlers): AbortController {
  return readEventStream("/api/ai/generate/stream", data, {
    onEvent: (event) => {
      if (typeof event.content === "string") handlers.onChunk(event.content);
    },
    onDone: handlers.onDone,
    onError: handlers.onError,
  });
}

export interface AnswerHandlers extends StreamHandlers {
  onSources: (sources: AiAnswerSource[]) => void;
}

// AI Answers in search: the sources arrive first, then the answer streams.
export function streamAnswer(params: AiAskParams, handlers: AnswerHandlers): AbortController {
  return readEventStream("/api/ai/answers", params, {
    onEvent: (event) => {
      if (Array.isArray(event.sources)) handlers.onSources(event.sources as AiAnswerSource[]);
      if (typeof event.content === "string") handlers.onChunk(event.content);
    },
    onDone: handlers.onDone,
    onError: handlers.onError,
  });
}

interface EventStreamHandlers {
  onEvent: (event: Record<string, unknown>) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

// Server-sent events over fetch, the server's `data: {...}` lines parsed
// one by one. An `error` field ends the stream; so does [DONE]. Returns the
// controller that cancels it.
function readEventStream(url: string, body: unknown, handlers: EventStreamHandlers): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let message = `The AI request failed (${response.status})`;
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
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            finished = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            if (parsed.error) {
              handlers.onError(String(parsed.error));
              return;
            }
            handlers.onEvent(parsed);
          } catch {
            /* partial or malformed line: skip */
          }
        }
      }
      handlers.onDone();
    } catch (err: any) {
      if (err?.name === "AbortError") {
        handlers.onDone();
        return;
      }
      handlers.onError(err?.message ?? "The AI request failed");
    }
  })();
  return controller;
}
