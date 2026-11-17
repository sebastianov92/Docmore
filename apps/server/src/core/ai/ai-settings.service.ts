import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EncryptionPurpose, EncryptionService } from '../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AI_PROVIDERS, AiModelInfo, AiProviderId, PROVIDER_LABELS } from './ai.constants';
import { ProviderPatchDto, UpdateAiSettingsDto } from './dto/ai.dto';
import { isHttpUrl, normalizeBaseUrl } from './ai.utils';

export interface StoredProvider {
  apiKey?: string | null; // encrypted
  baseUrl?: string | null;
  name?: string | null;
  models?: AiModelInfo[];
  checkedAt?: string | null;
}

export interface ModelChoice {
  provider: AiProviderId;
  model: string;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, StoredProvider>>;
  generation: ModelChoice | null;
  embedding: ModelChoice | null;
}

// What admins see: never the key itself.
export interface AiSettingsView {
  providers: Record<
    AiProviderId,
    {
      label: string;
      hasApiKey: boolean;
      needsApiKey: boolean;
      baseUrl: string | null;
      defaultBaseUrl: string | null;
      name: string | null;
      models: AiModelInfo[];
      checkedAt: string | null;
    }
  >;
  generation: ModelChoice | null;
  embedding: ModelChoice | null;
  envFallback: { provider: string; model: string | null } | null;
}

const NEEDS_KEY: Record<AiProviderId, boolean> = {
  openai: true,
  anthropic: true,
  gemini: true,
  ollama: false,
  compatible: false,
};

@Injectable()
export class AiSettingsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly encryption: EncryptionService,
    private readonly environment: EnvironmentService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  async load(workspaceId: string): Promise<AiSettings> {
    const row = await this.db
      .selectFrom('aiSettings')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    return {
      providers: (asObject(row?.providers) as AiSettings['providers']) ?? {},
      generation: (asObject(row?.generation) as ModelChoice | null) ?? null,
      embedding: (asObject(row?.embedding) as ModelChoice | null) ?? null,
    };
  }

  async view(workspaceId: string): Promise<AiSettingsView> {
    const settings = await this.load(workspaceId);
    const providers = {} as AiSettingsView['providers'];
    for (const id of AI_PROVIDERS) {
      const stored = settings.providers[id] ?? {};
      providers[id] = {
        label: PROVIDER_LABELS[id],
        hasApiKey: Boolean(stored.apiKey),
        needsApiKey: NEEDS_KEY[id],
        baseUrl: stored.baseUrl ?? null,
        defaultBaseUrl: normalizeBaseUrl(null, id),
        name: stored.name ?? null,
        models: stored.models ?? [],
        checkedAt: stored.checkedAt ?? null,
      };
    }
    const envDriver = this.environment.getAiDriver?.();
    return {
      providers,
      generation: settings.generation,
      embedding: settings.embedding,
      envFallback: envDriver
        ? { provider: envDriver, model: this.environment.getAiCompletionModel?.() ?? null }
        : null,
    };
  }

  async update(workspaceId: string, dto: UpdateAiSettingsDto): Promise<AiSettingsView> {
    const current = await this.load(workspaceId);
    const providers = { ...current.providers };

    for (const [id, patch] of Object.entries(dto.providers ?? {})) {
      if (!AI_PROVIDERS.includes(id as AiProviderId)) {
        throw new BadRequestException(`Unknown provider: ${id}`);
      }
      providers[id as AiProviderId] = this.applyPatch(id as AiProviderId, providers[id as AiProviderId] ?? {}, patch);
    }

    const generation = dto.generation === undefined ? current.generation : this.readChoice(dto.generation, providers);
    const embedding =
      dto.embedding === undefined ? current.embedding : this.readChoice(dto.embedding, providers, 'embedding');

    await this.save(workspaceId, { providers, generation, embedding });

    // Vectors from one model mean nothing to another: start the index over.
    if (dto.embedding !== undefined && !sameChoice(current.embedding, embedding)) {
      await this.aiQueue.add(
        QueueJob.WORKSPACE_RESET_EMBEDDINGS,
        { workspaceId },
        { removeOnComplete: true, removeOnFail: true },
      );
    }
    return this.view(workspaceId);
  }

  // The embedding model: the saved choice, else the env configuration.
  async embeddingChoice(workspaceId: string): Promise<ModelChoice | null> {
    const settings = await this.load(workspaceId);
    if (settings.embedding) return settings.embedding;
    const driver = this.environment.getAiDriver?.();
    const model = this.environment.getAiEmbeddingModel?.();
    if (!driver || !model) return null;
    const provider = (driver === 'openai-compatible' ? 'compatible' : driver) as AiProviderId;
    return AI_PROVIDERS.includes(provider) && provider !== 'anthropic' ? { provider, model } : null;
  }

  async rememberModels(workspaceId: string, provider: AiProviderId, models: AiModelInfo[]) {
    const current = await this.load(workspaceId);
    const providers = {
      ...current.providers,
      [provider]: { ...(current.providers[provider] ?? {}), models, checkedAt: new Date().toISOString() },
    };
    await this.save(workspaceId, { ...current, providers });
  }

  // Plain credentials for one provider, with env variables as a fallback
  // for deployments configured the upstream way.
  async credentials(
    workspaceId: string,
    provider: AiProviderId,
    override?: { apiKey?: string; baseUrl?: string },
  ): Promise<{ apiKey: string | null; baseUrl: string | null; name: string | null }> {
    const settings = await this.load(workspaceId);
    const stored = settings.providers[provider] ?? {};
    let apiKey = override?.apiKey?.trim() || (stored.apiKey ? this.decrypt(stored.apiKey) : null);
    let baseUrl = normalizeBaseUrl(override?.baseUrl ?? stored.baseUrl, provider);
    if (!apiKey) apiKey = this.envApiKey(provider);
    if (!baseUrl) baseUrl = this.envBaseUrl(provider);
    return { apiKey, baseUrl, name: stored.name ?? null };
  }

  // The generation model: the saved choice, else the env configuration.
  async generationChoice(workspaceId: string): Promise<ModelChoice | null> {
    const settings = await this.load(workspaceId);
    if (settings.generation) return settings.generation;
    const driver = this.environment.getAiDriver?.();
    const model = this.environment.getAiCompletionModel?.();
    if (!driver || !model) return null;
    const provider = (driver === 'openai-compatible' ? 'compatible' : driver) as AiProviderId;
    return AI_PROVIDERS.includes(provider) ? { provider, model } : null;
  }

  private applyPatch(id: AiProviderId, stored: StoredProvider, patch: ProviderPatchDto): StoredProvider {
    const next: StoredProvider = { ...stored };
    if (patch.clearApiKey) {
      next.apiKey = null;
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      next.apiKey = this.encryption.encrypt(patch.apiKey.trim(), EncryptionPurpose.AI_SECRETS);
    }
    if (patch.baseUrl !== undefined) {
      const trimmed = patch.baseUrl.trim().replace(/\/+$/, '');
      if (trimmed && !isHttpUrl(trimmed)) {
        throw new BadRequestException('The base URL must start with http:// or https://');
      }
      next.baseUrl = trimmed || null;
    }
    if (patch.name !== undefined) {
      next.name = patch.name.trim() || null;
    }
    // A changed endpoint or key makes the cached catalog stale.
    if (patch.apiKey || patch.clearApiKey || patch.baseUrl !== undefined) {
      next.models = [];
      next.checkedAt = null;
    }
    return next;
  }

  private readChoice(
    choice: { provider: string; model: string } | null,
    providers: AiSettings['providers'],
    kind: 'chat' | 'embedding' = 'chat',
  ): ModelChoice | null {
    if (!choice) return null;
    const provider = choice.provider as AiProviderId;
    if (kind === 'embedding' && provider === 'anthropic') {
      throw new BadRequestException('Anthropic has no embedding models; pick another provider for embeddings');
    }
    const stored = providers[provider] ?? {};
    const configured = NEEDS_KEY[provider] ? Boolean(stored.apiKey) || Boolean(this.envApiKey(provider)) : true;
    if (!configured) {
      throw new BadRequestException(`Add an API key for ${PROVIDER_LABELS[provider]} first`);
    }
    if (provider === 'compatible' && !stored.baseUrl && !this.envBaseUrl(provider)) {
      throw new BadRequestException('Set the base URL of the OpenAI-compatible server first');
    }
    return { provider, model: choice.model.trim() };
  }

  private async save(workspaceId: string, settings: AiSettings) {
    // Plain objects: the pg driver serializes them for jsonb. A stringified
    // parameter cast to ::jsonb would be stored as a JSON string instead.
    const values = {
      providers: settings.providers as any,
      generation: (settings.generation ?? null) as any,
      embedding: (settings.embedding ?? null) as any,
    };
    await this.db
      .insertInto('aiSettings')
      .values({ workspaceId, ...values })
      .onConflict((oc) => oc.column('workspaceId').doUpdateSet({ ...values, updatedAt: new Date() }))
      .execute();
  }

  private decrypt(value: string): string | null {
    try {
      return this.encryption.decrypt(value, EncryptionPurpose.AI_SECRETS);
    } catch {
      return null;
    }
  }

  private envApiKey(provider: AiProviderId): string | null {
    switch (provider) {
      case 'openai':
      case 'compatible':
        return this.environment.getOpenAiApiKey?.() || null;
      case 'gemini':
        return this.environment.getGeminiApiKey?.() || null;
      default:
        return null;
    }
  }

  private envBaseUrl(provider: AiProviderId): string | null {
    switch (provider) {
      case 'openai':
      case 'compatible':
        return this.environment.getOpenAiApiUrl?.() || null;
      case 'ollama':
        return this.environment.getOllamaApiUrl?.() || null;
      default:
        return null;
    }
  }
}

function sameChoice(a: ModelChoice | null, b: ModelChoice | null): boolean {
  return (a?.provider ?? null) === (b?.provider ?? null) && (a?.model ?? null) === (b?.model ?? null);
}

// jsonb comes back parsed; rows written as a JSON string by an older build
// are parsed here so they still load.
function asObject<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}
