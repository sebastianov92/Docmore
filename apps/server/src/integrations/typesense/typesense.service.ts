import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Client } from 'typesense';
import { EnvironmentService } from '../environment/environment.service';

export const PAGES_COLLECTION = 'docmore_pages';

export interface PageDocument {
  id: string;
  workspaceId: string;
  spaceId: string;
  spaceArchived: boolean;
  slugId: string;
  title: string;
  content: string;
  icon: string;
  parentPageId: string;
  creatorId: string;
  labelIds: string[];
  createdAt: number;
  updatedAt: number;
}

// The Typesense connection and the pages collection. Nothing here runs
// unless SEARCH_DRIVER=typesense; with it, the collection is created on
// start and `ready` says whether searches can go to Typesense at all.
@Injectable()
export class TypesenseService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TypesenseService.name);
  private client: Client | null = null;
  private readyFlag = false;

  constructor(private readonly environment: EnvironmentService) {}

  get enabled(): boolean {
    return this.environment.getSearchDriver() === 'typesense';
  }

  get ready(): boolean {
    return this.enabled && this.readyFlag;
  }

  getClient(): Client {
    if (!this.client) {
      const url = new URL(this.environment.getTypesenseUrl());
      const protocol = url.protocol.replace(':', '') as 'http' | 'https';
      const port = url.port ? Number(url.port) : protocol === 'https' ? 443 : 80;
      this.client = new Client({
        nodes: [{ host: url.hostname, port, protocol }],
        apiKey: this.environment.getTypesenseApiKey() ?? '',
        connectionTimeoutSeconds: 10,
        retryIntervalSeconds: 0.5,
        numRetries: 2,
      });
    }
    return this.client;
  }

  async onApplicationBootstrap() {
    if (!this.enabled) return;
    await this.ensureCollection();
  }

  async ensureCollection(): Promise<boolean> {
    if (!this.enabled) return false;
    const locale = this.environment.getTypesenseLocale() || 'en';
    try {
      const client = this.getClient();
      try {
        await client.collections(PAGES_COLLECTION).retrieve();
      } catch (err: any) {
        if (err?.httpStatus !== 404) throw err;
        await client.collections().create({
          name: PAGES_COLLECTION,
          fields: [
            { name: 'workspaceId', type: 'string', facet: true },
            { name: 'spaceId', type: 'string', facet: true },
            { name: 'spaceArchived', type: 'bool' },
            { name: 'slugId', type: 'string', index: false, optional: true },
            { name: 'title', type: 'string', locale },
            { name: 'content', type: 'string', locale },
            { name: 'icon', type: 'string', index: false, optional: true },
            { name: 'parentPageId', type: 'string', index: false, optional: true },
            { name: 'creatorId', type: 'string', facet: true, optional: true },
            { name: 'labelIds', type: 'string[]', facet: true, optional: true },
            { name: 'createdAt', type: 'int64' },
            { name: 'updatedAt', type: 'int64' },
          ],
          default_sorting_field: 'updatedAt',
          token_separators: ['-', '_', '/', '.'],
        } as any);
        this.logger.log(`Created Typesense collection ${PAGES_COLLECTION}`);
      }
      this.readyFlag = true;
      return true;
    } catch (err: any) {
      this.readyFlag = false;
      this.logger.warn(
        `Typesense at ${this.environment.getTypesenseUrl()} is not reachable (${err?.message ?? err}); searches use Postgres until it is`,
      );
      return false;
    }
  }

  async documentCount(): Promise<number> {
    const info = await this.getClient().collections(PAGES_COLLECTION).retrieve();
    return Number((info as any)?.num_documents ?? 0);
  }
}
