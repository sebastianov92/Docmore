import {
  classifyAnthropicModel,
  classifyCompatibleModel,
  classifyGeminiModel,
  classifyOllamaModel,
  classifyOpenAiModel,
  normalizeBaseUrl,
  ollamaRoot,
  sortModels,
} from './ai.utils';
import { buildUserPrompt, temperatureFor } from './ai-prompts';

describe('ai.utils', () => {
  it('keeps text models from OpenAI and drops the rest', () => {
    expect(classifyOpenAiModel('gpt-4.1-mini')?.kind).toBe('chat');
    expect(classifyOpenAiModel('o3')?.kind).toBe('chat');
    expect(classifyOpenAiModel('text-embedding-3-small')?.kind).toBe('embedding');
    expect(classifyOpenAiModel('whisper-1')).toBeNull();
    expect(classifyOpenAiModel('dall-e-3')).toBeNull();
    expect(classifyOpenAiModel('tts-1')).toBeNull();
    expect(classifyOpenAiModel('davinci-002')).toBeNull();
  });

  it('reads Gemini capabilities from the methods list', () => {
    expect(
      classifyGeminiModel({
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        supportedGenerationMethods: ['generateContent'],
      }),
    ).toEqual({ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', kind: 'chat' });
    expect(
      classifyGeminiModel({ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] })?.kind,
    ).toBe('embedding');
    expect(classifyGeminiModel({ name: 'models/imagen-3', supportedGenerationMethods: ['predict'] })).toBeNull();
  });

  it('guesses embedding models by name for Ollama and compatible servers', () => {
    expect(classifyOllamaModel('nomic-embed-text:latest').kind).toBe('embedding');
    expect(classifyOllamaModel('llama3.2:3b').kind).toBe('chat');
    expect(classifyCompatibleModel('bge-m3').kind).toBe('embedding');
    expect(classifyCompatibleModel('mistral-small').kind).toBe('chat');
    expect(classifyAnthropicModel({ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' })).toEqual({
      id: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      kind: 'chat',
    });
  });

  it('sorts newest-looking ids first', () => {
    const ids = sortModels([
      { id: 'gpt-4o', label: '', kind: 'chat' },
      { id: 'gpt-4.1', label: '', kind: 'chat' },
      { id: 'gpt-5', label: '', kind: 'chat' },
    ]).map((m) => m.id);
    expect(ids).toEqual(['gpt-5', 'gpt-4o', 'gpt-4.1']);
  });

  it('normalizes base urls with provider defaults', () => {
    expect(normalizeBaseUrl('', 'openai')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('http://minipc:11434/', 'ollama')).toBe('http://minipc:11434');
    expect(normalizeBaseUrl(undefined, 'compatible')).toBeNull();
    expect(ollamaRoot('http://minipc:11434/v1')).toBe('http://minipc:11434');
  });
});

describe('ai-prompts', () => {
  it('builds the instruction and wraps the text', () => {
    const prompt = buildUserPrompt({ action: 'make_shorter', content: 'Some long text.' });
    expect(prompt.startsWith('Make it shorter.')).toBe(true);
    expect(prompt).toContain('---\nSome long text.\n---');
  });

  it('uses the extra prompt for translate, tone and custom', () => {
    expect(buildUserPrompt({ action: 'translate', content: 'Hola', prompt: 'German' })).toContain('into German');
    expect(buildUserPrompt({ action: 'change_tone', content: 'x', prompt: 'friendly' })).toContain('a friendly tone');
    expect(buildUserPrompt({ action: 'custom', content: 'x', prompt: 'Turn into a checklist' })).toContain(
      'Turn into a checklist',
    );
    expect(buildUserPrompt({ action: 'custom', content: '', prompt: 'Write a haiku about pumps' })).toBe(
      'Write a haiku about pumps',
    );
  });

  it('keeps corrections cold and creative work warmer', () => {
    expect(temperatureFor('fix_spelling_grammar')).toBeLessThan(temperatureFor('continue_writing'));
  });
});
