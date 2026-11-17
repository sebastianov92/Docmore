import { AiAction, AiModelInfo, AiProviderId, DEFAULT_BASE_URLS } from './ai.constants';

// Model ids that are not for text: images, audio, moderation, realtime.
const NOT_TEXT = /(dall-e|whisper|tts|audio|realtime|moderation|image|imagen|veo|aqa|vision-preview|transcribe|sora|embedding-?gecko-?bison|bison|learnlm)/i;
const EMBEDDING = /(embed|embedding|bge|nomic|minilm|e5-|gte-|arctic-embed|mxbai|snowflake)/i;

export function classifyOpenAiModel(id: string): AiModelInfo | null {
  if (NOT_TEXT.test(id) && !/embedding/i.test(id)) return null;
  if (/embedding/i.test(id)) return { id, label: id, kind: 'embedding' };
  if (/^(gpt|o\d|chatgpt|codex)/i.test(id)) return { id, label: id, kind: 'chat' };
  return null;
}

export function classifyCompatibleModel(id: string): AiModelInfo {
  return { id, label: id, kind: EMBEDDING.test(id) ? 'embedding' : 'chat' };
}

export function classifyOllamaModel(name: string): AiModelInfo {
  return { id: name, label: name, kind: EMBEDDING.test(name) ? 'embedding' : 'chat' };
}

export function classifyGeminiModel(model: {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}): AiModelInfo | null {
  const id = model.name.replace(/^models\//, '');
  const methods = model.supportedGenerationMethods ?? [];
  if (methods.includes('embedContent')) {
    return { id, label: model.displayName || id, kind: 'embedding' };
  }
  if (methods.includes('generateContent') && !NOT_TEXT.test(id)) {
    return { id, label: model.displayName || id, kind: 'chat' };
  }
  return null;
}

export function classifyAnthropicModel(model: { id: string; display_name?: string }): AiModelInfo {
  return { id: model.id, label: model.display_name || model.id, kind: 'chat' };
}

// Newest-looking ids first, so the dropdown opens on something current.
export function sortModels(models: AiModelInfo[]): AiModelInfo[] {
  return [...models].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

export function normalizeBaseUrl(url: string | null | undefined, provider: AiProviderId): string | null {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URLS[provider] ?? null;
  return trimmed;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Ollama answers on /api/*; its OpenAI-compatible endpoint lives at /v1.
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '').replace(/\/api$/, '');
}

export function actionLabel(action: AiAction): string {
  return action.replace(/_/g, ' ');
}

export function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
