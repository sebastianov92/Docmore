import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { AiModelInfo, AiProviderId, PROVIDER_LABELS, PROVIDER_TIMEOUT_MS } from './ai.constants';
import { AiSettingsService, ModelChoice } from './ai-settings.service';
import {
  classifyAnthropicModel,
  classifyCompatibleModel,
  classifyGeminiModel,
  classifyOllamaModel,
  classifyOpenAiModel,
  ollamaRoot,
  sortModels,
} from './ai.utils';

// Turns saved credentials into AI SDK models, and asks each provider which
// models it offers so admins pick from a real list.
@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  constructor(private readonly settings: AiSettingsService) {}

  async listModels(
    workspaceId: string,
    provider: AiProviderId,
    override?: { apiKey?: string; baseUrl?: string },
  ): Promise<AiModelInfo[]> {
    const creds = await this.settings.credentials(workspaceId, provider, override);
    const needsKey = provider === 'openai' || provider === 'anthropic' || provider === 'gemini';
    if (needsKey && !creds.apiKey) {
      throw new BadRequestException(`Add an API key for ${PROVIDER_LABELS[provider]} first`);
    }
    if (!creds.baseUrl) {
      throw new BadRequestException(`Set the base URL for ${PROVIDER_LABELS[provider]} first`);
    }

    let models: AiModelInfo[];
    switch (provider) {
      case 'openai': {
        const data = await this.getJson(`${creds.baseUrl}/models`, { Authorization: `Bearer ${creds.apiKey}` });
        models = (data?.data ?? []).map((m: any) => classifyOpenAiModel(String(m.id))).filter(Boolean);
        break;
      }
      case 'compatible': {
        const headers = creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {};
        const data = await this.getJson(`${creds.baseUrl}/models`, headers);
        models = (data?.data ?? []).map((m: any) => classifyCompatibleModel(String(m.id)));
        break;
      }
      case 'anthropic': {
        const data = await this.getJson(`${creds.baseUrl}/models?limit=1000`, {
          'x-api-key': creds.apiKey,
          'anthropic-version': '2023-06-01',
        });
        models = (data?.data ?? []).map((m: any) => classifyAnthropicModel(m));
        break;
      }
      case 'gemini': {
        const data = await this.getJson(
          `${creds.baseUrl}/models?pageSize=1000&key=${encodeURIComponent(creds.apiKey)}`,
          {},
        );
        models = (data?.models ?? []).map((m: any) => classifyGeminiModel(m)).filter(Boolean);
        break;
      }
      case 'ollama': {
        const data = await this.getJson(`${ollamaRoot(creds.baseUrl)}/api/tags`, {});
        models = (data?.models ?? []).map((m: any) => classifyOllamaModel(String(m.name)));
        break;
      }
    }

    const sorted = sortModels(models);
    if (!override?.apiKey && !override?.baseUrl) {
      await this.settings.rememberModels(workspaceId, provider, sorted);
    }
    return sorted;
  }

  // A language model for the workspace's chosen generation provider.
  async languageModel(workspaceId: string, choice?: ModelChoice | null): Promise<LanguageModel> {
    const picked = choice ?? (await this.settings.generationChoice(workspaceId));
    if (!picked) {
      throw new BadRequestException('No AI model is configured. An admin can set one under Settings > AI.');
    }
    const creds = await this.settings.credentials(workspaceId, picked.provider);
    switch (picked.provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey: creds.apiKey ?? '', baseURL: creds.baseUrl ?? undefined })(picked.model);
      }
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey: creds.apiKey ?? '', baseURL: creds.baseUrl ?? undefined })(picked.model);
      }
      case 'gemini': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey: creds.apiKey ?? '', baseURL: creds.baseUrl ?? undefined })(
          picked.model,
        );
      }
      case 'ollama': {
        const { createOllama } = await import('ai-sdk-ollama');
        // ai-sdk-ollama appends /api/... itself: the base is the host root
        return createOllama({ baseURL: ollamaRoot(creds.baseUrl ?? 'http://localhost:11434') })(picked.model);
      }
      case 'compatible': {
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        return createOpenAICompatible({
          name: creds.name || 'compatible',
          baseURL: creds.baseUrl ?? '',
          apiKey: creds.apiKey ?? undefined,
        }).chatModel(picked.model);
      }
    }
  }

  // An embedding model for the chosen provider. Anthropic offers none.
  async embeddingModel(workspaceId: string, choice?: ModelChoice | null): Promise<EmbeddingModel> {
    const picked = choice ?? (await this.settings.embeddingChoice(workspaceId));
    if (!picked) {
      throw new BadRequestException('No embedding model is configured. An admin can pick one under Settings > AI.');
    }
    const creds = await this.settings.credentials(workspaceId, picked.provider);
    switch (picked.provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey: creds.apiKey ?? '', baseURL: creds.baseUrl ?? undefined }).textEmbeddingModel(
          picked.model,
        );
      }
      case 'gemini': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({
          apiKey: creds.apiKey ?? '',
          baseURL: creds.baseUrl ?? undefined,
        }).textEmbeddingModel(picked.model);
      }
      case 'ollama': {
        const { createOllama } = await import('ai-sdk-ollama');
        return createOllama({
          baseURL: ollamaRoot(creds.baseUrl ?? 'http://localhost:11434'),
        }).textEmbeddingModel(picked.model);
      }
      case 'compatible': {
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        return createOpenAICompatible({
          name: creds.name || 'compatible',
          baseURL: creds.baseUrl ?? '',
          apiKey: creds.apiKey ?? undefined,
        }).textEmbeddingModel(picked.model);
      }
      default:
        throw new BadRequestException(
          `${PROVIDER_LABELS[picked.provider]} has no embedding models; pick another provider for embeddings`,
        );
    }
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new BadRequestException(
          res.status === 401 || res.status === 403
            ? 'The provider rejected the API key'
            : `The provider answered ${res.status}${text ? `: ${text}` : ''}`,
        );
      }
      return await res.json();
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.debug(`model listing failed for ${url}: ${err?.message}`);
      throw new BadRequestException(
        err?.name === 'AbortError'
          ? 'The provider did not answer in time'
          : `Could not reach the provider: ${err?.cause?.message ?? err?.message ?? 'unknown error'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
