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
  availableActions: AiAction[];
}

export interface AiGenerateRequest {
  action: AiAction;
  content: string;
  prompt?: string;
}
