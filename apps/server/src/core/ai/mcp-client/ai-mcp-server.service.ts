import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { EncryptionPurpose, EncryptionService } from '../../../integrations/encryption/encryption.service';
import WorkspaceAbilityFactory from '../../casl/abilities/workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../../casl/interfaces/workspace-ability.type';
import { assertPublicUrl } from '../../../common/helpers/public-url';
import { McpHttpClient, McpToolInfo } from './mcp-http-client';

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  scope: 'workspace' | 'personal';
  creatorId: string | null;
  hasAuth: boolean;
  authHeader: string | null;
  allowedTools: string[] | null;
  requireConfirmation: boolean;
  enabled: boolean;
  tools: McpToolInfo[];
  toolsCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface McpServerRow {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  scope: string;
  creatorId: string | null;
  auth: string | null;
  allowedTools: unknown;
  requireConfirmation: boolean;
  enabled: boolean;
  toolCache: unknown;
  toolsCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

const TOOL_CACHE_MS = 10 * 60 * 1000;
const MAX_SERVERS = 20;

// The MCP servers the chat may call: workspace ones an admin adds for
// everybody, personal ones each member adds for themselves. Tool lists are
// cached ten minutes; credentials are one header, encrypted at rest.
@Injectable()
export class AiMcpServerService {
  private readonly logger = new Logger(AiMcpServerService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly encryption: EncryptionService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  async list(user: User, workspace: Workspace): Promise<McpServerView[]> {
    const rows = await this.visibleRows(user, workspace);
    return rows.map((r) => this.view(r));
  }

  // Every enabled server this user may use: the workspace ones and their own.
  async enabledFor(user: User, workspace: Workspace): Promise<McpServerRow[]> {
    const rows = await this.visibleRows(user, workspace);
    return rows.filter((r) => r.enabled);
  }

  async create(
    user: User,
    workspace: Workspace,
    data: { name: string; url: string; scope: 'workspace' | 'personal'; authHeader?: string; authValue?: string; requireConfirmation?: boolean },
  ): Promise<McpServerView> {
    if (data.scope === 'workspace') this.assertAdmin(user, workspace);
    const url = await this.checkUrl(data.url, data.scope);
    const count = await this.db
      .selectFrom('aiMcpServers')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .where((eb) => (data.scope === 'personal' ? eb('creatorId', '=', user.id) : eb('scope', '=', 'workspace')))
      .executeTakeFirst();
    if (Number(count?.n ?? 0) >= MAX_SERVERS) throw new BadRequestException(`Up to ${MAX_SERVERS} MCP servers`);
    const row = await this.db
      .insertInto('aiMcpServers')
      .values({
        workspaceId: workspace.id,
        name: data.name.trim().slice(0, 80),
        url,
        scope: data.scope,
        creatorId: user.id,
        auth: this.encodeAuth(data.authHeader, data.authValue),
        allowedTools: null,
        requireConfirmation: data.requireConfirmation ?? true,
        enabled: true,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Try to reach it right away so the list shows its tools (or the error).
    const refreshed = await this.refreshTools(row as any).catch(() => row);
    return this.view(refreshed as any);
  }

  async update(
    user: User,
    workspace: Workspace,
    data: {
      serverId: string;
      name?: string;
      url?: string;
      authHeader?: string;
      authValue?: string;
      clearAuth?: boolean;
      allowedTools?: string[] | null;
      requireConfirmation?: boolean;
      enabled?: boolean;
    },
  ): Promise<McpServerView> {
    const row = await this.ownedRow(user, workspace, data.serverId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name.trim().slice(0, 80);
    if (data.url !== undefined) patch.url = await this.checkUrl(data.url, row.scope as any);
    if (data.clearAuth) patch.auth = null;
    else if (data.authValue !== undefined) patch.auth = this.encodeAuth(data.authHeader, data.authValue);
    if (data.allowedTools !== undefined) patch.allowedTools = data.allowedTools === null ? null : (data.allowedTools.slice(0, 200) as any);
    if (data.requireConfirmation !== undefined) patch.requireConfirmation = data.requireConfirmation;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    const updated = await this.db
      .updateTable('aiMcpServers')
      .set(patch as any)
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const refreshed =
      data.url !== undefined || data.authValue !== undefined
        ? await this.refreshTools(updated as any).catch(() =>
            this.db.selectFrom('aiMcpServers').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow(),
          )
        : updated;
    return this.view(refreshed as any);
  }

  async remove(user: User, workspace: Workspace, serverId: string): Promise<void> {
    const row = await this.ownedRow(user, workspace, serverId);
    await this.db.updateTable('aiMcpServers').set({ deletedAt: new Date() }).where('id', '=', row.id).execute();
  }

  // Reach the server now and store its tool list.
  async test(user: User, workspace: Workspace, serverId: string): Promise<McpServerView> {
    const row = await this.ownedRow(user, workspace, serverId);
    const refreshed = await this.refreshTools(row);
    return this.view(refreshed);
  }

  // The tools of one server, from the cache when it is fresh.
  async tools(row: McpServerRow): Promise<McpToolInfo[]> {
    const fresh = row.toolsCheckedAt && Date.now() - new Date(row.toolsCheckedAt).getTime() < TOOL_CACHE_MS;
    const cached = Array.isArray(row.toolCache) ? (row.toolCache as McpToolInfo[]) : null;
    if (fresh && cached) return this.filterAllowed(row, cached);
    try {
      const refreshed = await this.refreshTools(row);
      return this.filterAllowed(row, (refreshed.toolCache as McpToolInfo[]) ?? []);
    } catch (err: any) {
      this.logger.debug(`MCP ${row.name}: ${err?.message}`);
      return cached ? this.filterAllowed(row, cached) : [];
    }
  }

  client(row: McpServerRow): McpHttpClient {
    return new McpHttpClient(row.url, this.decodeAuth(row.auth));
  }

  // ---- internals ----------------------------------------------------------

  private async refreshTools(row: McpServerRow): Promise<McpServerRow> {
    const client = this.client(row);
    try {
      const tools = await client.listTools();
      const updated = await this.db
        .updateTable('aiMcpServers')
        .set({ toolCache: tools as any, toolsCheckedAt: new Date(), lastError: null })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return updated as any;
    } catch (err: any) {
      const message = String(err?.message ?? 'Could not reach the server').slice(0, 300);
      await this.db.updateTable('aiMcpServers').set({ lastError: message, toolsCheckedAt: new Date() }).where('id', '=', row.id).execute();
      throw new BadRequestException(message);
    } finally {
      await client.close();
    }
  }

  private filterAllowed(row: McpServerRow, tools: McpToolInfo[]): McpToolInfo[] {
    const allowed = Array.isArray(row.allowedTools) ? new Set(row.allowedTools as string[]) : null;
    return allowed ? tools.filter((t) => allowed.has(t.name)) : tools;
  }

  private async visibleRows(user: User, workspace: Workspace): Promise<McpServerRow[]> {
    const rows = await this.db
      .selectFrom('aiMcpServers')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .where((eb) => eb.or([eb('scope', '=', 'workspace'), eb('creatorId', '=', user.id)]))
      .orderBy('scope', 'desc')
      .orderBy('createdAt', 'asc')
      .execute();
    return rows as any;
  }

  private async ownedRow(user: User, workspace: Workspace, serverId: string): Promise<McpServerRow> {
    const row = (await this.db
      .selectFrom('aiMcpServers')
      .selectAll()
      .where('id', '=', serverId)
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst()) as McpServerRow | undefined;
    if (!row) throw new NotFoundException('MCP server not found');
    if (row.scope === 'workspace') this.assertAdmin(user, workspace);
    else if (row.creatorId !== user.id) throw new ForbiddenException();
    return row;
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)) {
      throw new ForbiddenException('Only admins manage workspace MCP servers');
    }
  }

  // Workspace servers may live on the LAN (an admin put them there); a
  // member's personal server must be a public address, so nobody probes the
  // internal network through the chat.
  private async checkUrl(raw: string, scope: 'workspace' | 'personal'): Promise<string> {
    const url = String(raw ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('The MCP server URL must start with http:// or https://');
    try {
      new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }
    if (scope === 'personal') await assertPublicUrl(url);
    return url.slice(0, 2000);
  }

  private encodeAuth(header?: string, value?: string): string | null {
    const v = String(value ?? '').trim();
    if (!v) return null;
    const h = String(header ?? 'Authorization').trim() || 'Authorization';
    const headerValue = h.toLowerCase() === 'authorization' && !/^\w+ /.test(v) ? `Bearer ${v}` : v;
    return this.encryption.encrypt(JSON.stringify({ headerName: h, headerValue }), EncryptionPurpose.WEBHOOK_SECRETS);
  }

  private decodeAuth(auth: string | null): Record<string, string> {
    if (!auth) return {};
    try {
      const parsed = JSON.parse(this.encryption.decrypt(auth, EncryptionPurpose.WEBHOOK_SECRETS));
      return parsed?.headerName && parsed?.headerValue ? { [parsed.headerName]: parsed.headerValue } : {};
    } catch {
      return {};
    }
  }

  private view(row: McpServerRow): McpServerView {
    let authHeader: string | null = null;
    if (row.auth) {
      try {
        authHeader = JSON.parse(this.encryption.decrypt(row.auth, EncryptionPurpose.WEBHOOK_SECRETS))?.headerName ?? null;
      } catch {
        authHeader = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      scope: row.scope as any,
      creatorId: row.creatorId,
      hasAuth: Boolean(row.auth),
      authHeader,
      allowedTools: Array.isArray(row.allowedTools) ? (row.allowedTools as string[]) : null,
      requireConfirmation: row.requireConfirmation,
      enabled: row.enabled,
      tools: Array.isArray(row.toolCache) ? (row.toolCache as McpToolInfo[]) : [],
      toolsCheckedAt: row.toolsCheckedAt ? new Date(row.toolsCheckedAt).toISOString() : null,
      lastError: row.lastError,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
