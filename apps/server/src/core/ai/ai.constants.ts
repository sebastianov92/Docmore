export const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama', 'compatible'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_ACTIONS = [
  'improve_writing',
  'fix_spelling_grammar',
  'make_shorter',
  'make_longer',
  'simplify',
  'change_tone',
  'summarize',
  'explain',
  'continue_writing',
  'translate',
  'custom',
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export type ModelKind = 'chat' | 'embedding';

export interface AiModelInfo {
  id: string;
  label: string;
  kind: ModelKind;
}

// Where each provider answers by default; Ollama and compatible servers
// are always told explicitly.
export const DEFAULT_BASE_URLS: Partial<Record<AiProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
};

export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
  compatible: 'OpenAI-compatible',
};

export const MAX_INPUT_CHARS = 60_000;
export const MAX_PROMPT_CHARS = 2_000;
export const MAX_QUESTION_CHARS = 500;
export const MAX_OUTPUT_TOKENS = 4_096;
export const PROVIDER_TIMEOUT_MS = 20_000;
