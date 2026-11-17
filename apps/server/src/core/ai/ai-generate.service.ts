import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AiAction, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS } from './ai.constants';
import { AiProviderService } from './ai-provider.service';
import { buildUserPrompt, SYSTEM_PROMPT, temperatureFor } from './ai-prompts';
import { clampText } from './ai.utils';

export interface GenerateInput {
  action: AiAction;
  content: string;
  prompt?: string;
}

// Ask AI in the editor: one instruction over the selected Markdown.
@Injectable()
export class AiGenerateService {
  private readonly logger = new Logger(AiGenerateService.name);

  constructor(private readonly providers: AiProviderService) {}

  async *stream(workspaceId: string, input: GenerateInput, signal?: AbortSignal): AsyncGenerator<string> {
    const { streamText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId);
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(this.sanitize(input)),
      temperature: temperatureFor(input.action),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    });
    try {
      for await (const delta of result.textStream) {
        if (delta) yield delta;
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      throw new BadRequestException(this.explain(err));
    }
  }

  async complete(workspaceId: string, input: GenerateInput): Promise<string> {
    const { generateText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId);
    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(this.sanitize(input)),
        temperature: temperatureFor(input.action),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      return result.text;
    } catch (err: any) {
      throw new BadRequestException(this.explain(err));
    }
  }

  private sanitize(input: GenerateInput): GenerateInput {
    return {
      action: input.action,
      content: clampText(input.content ?? '', MAX_INPUT_CHARS),
      prompt: input.prompt ? clampText(input.prompt, MAX_PROMPT_CHARS) : undefined,
    };
  }

  // Provider errors are long and leak request bodies; keep the headline.
  private explain(err: any): string {
    const status = err?.statusCode ?? err?.status;
    const message: string = err?.message ?? 'unknown error';
    this.logger.warn(`AI generation failed: ${message.slice(0, 300)}`);
    if (status === 401 || status === 403) return 'The AI provider rejected the API key';
    if (status === 404) return 'The AI provider does not know this model';
    if (status === 429) return 'The AI provider is rate limiting requests; try again in a moment';
    if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return 'Could not reach the AI provider';
    }
    return `AI generation failed: ${message.split('\n')[0].slice(0, 200)}`;
  }
}
