import { AiAction } from './ai.constants';

export const SYSTEM_PROMPT = [
  'You are a writing assistant built into a documentation wiki.',
  'You receive a piece of a page as Markdown and an instruction.',
  'Reply with the result only: no preamble, no explanations, no quotes around it.',
  'Keep Markdown formatting (headings, lists, links, code) where the input had it.',
  'Keep the language of the input unless the instruction says to translate.',
  'Never invent facts, names or numbers that are not in the input.',
].join(' ');

const INSTRUCTIONS: Record<Exclude<AiAction, 'custom' | 'translate' | 'change_tone'>, string> = {
  improve_writing:
    'Improve the writing: clearer sentences, better flow, no change of meaning or tone. Keep roughly the same length.',
  fix_spelling_grammar:
    'Fix spelling, grammar and punctuation only. Do not rephrase or reorder anything that is already correct.',
  make_shorter: 'Make it shorter. Keep every essential point; drop filler and repetition.',
  make_longer: 'Make it longer: add useful detail, examples or transitions that fit the text. Do not pad.',
  simplify: 'Rewrite it in plain language a newcomer understands. Short sentences, common words, same meaning.',
  summarize: 'Summarize it. A short paragraph, or a few bullet points when the input is long or list-like.',
  explain: 'Explain what this text says and means, in plain language, as if to a colleague who has not read it.',
  continue_writing:
    'Continue writing from where the text stops. Match its voice, tense and formatting. Write one to three paragraphs; do not repeat the input.',
};

export interface PromptInput {
  action: AiAction;
  content: string;
  // Target language for translate, tone for change_tone, free text for custom.
  prompt?: string;
}

// The user turn: instruction first, then the text to work on.
export function buildUserPrompt(input: PromptInput): string {
  const { action, content } = input;
  const extra = (input.prompt ?? '').trim();
  let instruction: string;
  switch (action) {
    case 'translate':
      instruction = `Translate it into ${extra || 'English'}. Keep formatting, names and code unchanged.`;
      break;
    case 'change_tone':
      instruction = `Rewrite it in a ${extra || 'neutral'} tone. Keep the meaning and length.`;
      break;
    case 'custom':
      instruction = extra || 'Improve this text.';
      break;
    default:
      instruction = INSTRUCTIONS[action];
  }
  if (!content.trim()) {
    return action === 'custom' || action === 'continue_writing'
      ? instruction
      : `${instruction}\n\n(There is no selected text. Write a short, fitting result.)`;
  }
  return `${instruction}\n\n---\n${content}\n---`;
}

// Writing tasks want steady output; open-ended ones can roam a little.
export function temperatureFor(action: AiAction): number {
  switch (action) {
    case 'fix_spelling_grammar':
    case 'translate':
      return 0.1;
    case 'continue_writing':
    case 'custom':
      return 0.7;
    default:
      return 0.4;
  }
}
