import { BadRequestException, Injectable } from '@nestjs/common';
import { AiProviderService } from '../ai-provider.service';
import { AiGenerateService } from '../ai-generate.service';
import { AiEmbeddingService, AnswerSource, SearchOptions } from './ai-embedding.service';

export type AnswerEvent = { sources: AnswerSource[] } | { content: string };

export const NO_ANSWER_TEXT =
  "I couldn't find anything about that in the pages you can see.";

const ANSWER_SYSTEM = [
  "You answer questions about a team's wiki using only the excerpts you are given.",
  'Cite the excerpts you rely on as [1], [2] and so on.',
  'If the excerpts do not contain the answer, say so plainly; never invent facts, names or numbers.',
  'Answer in the language of the question. Use Markdown. Be concise.',
].join(' ');

const MAX_EXCERPT_CHARS = 1500;
const MAX_ANSWER_TOKENS = 1024;

// AI Answers in the search dialog: find the closest chunks the user may
// read, send the sources first, then stream the model's answer over them.
@Injectable()
export class AiAnswersService {
  constructor(
    private readonly embeddings: AiEmbeddingService,
    private readonly providers: AiProviderService,
    private readonly generate: AiGenerateService,
  ) {}

  async *answer(
    workspaceId: string,
    userId: string,
    query: string,
    opts: SearchOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AnswerEvent> {
    const sources = await this.embeddings.search(workspaceId, userId, query, opts);
    yield { sources };
    if (sources.length === 0) {
      yield { content: NO_ANSWER_TEXT };
      return;
    }

    const { streamText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId);
    const result = streamText({
      model,
      system: ANSWER_SYSTEM,
      prompt: buildAnswerPrompt(query, sources),
      temperature: 0.2,
      maxOutputTokens: MAX_ANSWER_TOKENS,
      abortSignal: signal,
    });
    try {
      for await (const delta of result.textStream) {
        if (delta) yield { content: delta };
      }
    } catch (err: any) {
      if (signal?.aborted) return;
      throw new BadRequestException(this.generate.explain(err));
    }
  }
}

export function buildAnswerPrompt(query: string, sources: AnswerSource[]): string {
  const excerpts = sources
    .map((source, i) => {
      const text = source.excerpt.length > MAX_EXCERPT_CHARS
        ? `${source.excerpt.slice(0, MAX_EXCERPT_CHARS)}…`
        : source.excerpt;
      return `[${i + 1}] Page "${source.title}" (space: ${source.spaceName})\n${text}`;
    })
    .join('\n\n');
  return `Question: ${query.trim()}\n\nExcerpts:\n\n${excerpts}`;
}
