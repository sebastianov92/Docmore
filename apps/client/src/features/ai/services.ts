import api from "@/lib/api-client";
import {
  AiConfig,
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

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

// Server-sent events over fetch; returns the controller that cancels it.
export function streamGeneration(data: AiGenerateRequest, handlers: StreamHandlers): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch("/api/ai/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let message = `The AI request failed (${response.status})`;
        try {
          const body = await response.json();
          message = body?.message ?? message;
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
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              handlers.onError(String(parsed.error));
              finished = true;
              break;
            }
            if (typeof parsed.content === "string") handlers.onChunk(parsed.content);
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
