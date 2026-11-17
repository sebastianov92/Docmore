export type AiProviderId = "openai" | "anthropic" | "gemini" | "ollama" | "compatible";
export const AI_PROVIDER_IDS: AiProviderId[] = ["openai", "anthropic", "gemini", "ollama", "compatible"];

export type AiAction =
  | "improve_writing"
  | "fix_spelling_grammar"
  | "make_shorter"
  | "make_longer"
  | "simplify"
  | "change_tone"
  | "summarize"
  | "explain"
  | "continue_writing"
  | "translate"
  | "custom";

export interface AiModelInfo {
  id: string;
  label: string;
  kind: "chat" | "embedding";
}

export interface ModelChoice {
  provider: AiProviderId;
  model: string;
}

export interface AiProviderView {
  label: string;
  hasApiKey: boolean;
  needsApiKey: boolean;
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  name: string | null;
  models: AiModelInfo[];
  checkedAt: string | null;
}

export interface AiSettingsView {
  providers: Record<AiProviderId, AiProviderView>;
  generation: ModelChoice | null;
  embedding: ModelChoice | null;
  envFallback: { provider: string; model: string | null } | null;
}

export interface AiProviderPatch {
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  name?: string;
}

export interface UpdateAiSettings {
  providers?: Partial<Record<AiProviderId, AiProviderPatch>>;
  generation?: ModelChoice | null;
  embedding?: ModelChoice | null;
}

export interface AiConfig {
  configured: boolean;
  generative: boolean;
  search: boolean;
  chat: boolean;
  model: ModelChoice | null;
  embeddingModel: ModelChoice | null;
  vectorStore: boolean;
  availableActions: AiAction[];
}

export interface AiAskParams {
  query: string;
  spaceId?: string;
  includeArchived?: boolean;
}

export interface AiAnswerSource {
  pageId: string;
  title: string;
  slugId: string;
  spaceSlug: string;
  spaceName: string;
  similarity: number;
  distance: number;
  chunkIndex: number;
  excerpt: string;
}

export interface AiEmbeddingStatus {
  available: boolean;
  enabled: boolean;
  model: ModelChoice | null;
  totalPages: number;
  indexedPages: number;
  pendingPages: number;
  queuedJobs: number;
  lastIndexedAt: string | null;
}

export interface AiGenerateRequest {
  action: AiAction;
  content: string;
  prompt?: string;
}
