import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiMcpServerService, McpServerRow } from './ai-mcp-server.service';
import { flattenMcpResult, McpToolInfo } from './mcp-http-client';

export const MCP_TOOL_PREFIX = 'mcp__';
const APPROVAL_TTL_MS = 30 * 60 * 1000;

export interface PendingApproval {
  approvalId: string;
  server: string;
  tool: string;
}

// Turns the user's MCP servers into AI SDK tools for one chat turn. A tool
// the server marks read-only runs at once; anything else, on a server that
// asks for confirmation, is parked as an approval the person answers in the
// chat, and the model is told to stop and ask.
@Injectable()
export class AiMcpToolsService {
  private readonly logger = new Logger(AiMcpToolsService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly servers: AiMcpServerService,
  ) {}

  async build(user: User, workspace: Workspace, chatId: string): Promise<Record<string, any>> {
    const rows = await this.servers.enabledFor(user, workspace);
    if (!rows.length) return {};
    const { dynamicTool, jsonSchema } = await import('ai');
    const tools: Record<string, any> = {};
    const used = new Set<string>();
    for (const row of rows) {
      const defs = await this.servers.tools(row);
      const slug = slugOf(row.name);
      for (const def of defs) {
        let name = `${MCP_TOOL_PREFIX}${slug}__${def.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        if (used.has(name)) name = `${name.slice(0, 60)}_${used.size}`;
        used.add(name);
        const readOnly = def.annotations?.readOnlyHint === true;
        const needsApproval = row.requireConfirmation && !readOnly;
        tools[name] = dynamicTool({
          description: describe(row, def, needsApproval),
          inputSchema: jsonSchema<Record<string, unknown>>(safeSchema(def.inputSchema)),
          execute: async (input: unknown, options: any) => {
            const args = (input ?? {}) as Record<string, unknown>;
            if (needsApproval) {
              return this.park(user, workspace, chatId, row, def.name, args, String(options?.toolCallId ?? ''));
            }
            return this.call(row, def.name, args);
          },
        });
      }
    }
    return tools;
  }

  // Run the parked call: the person said yes.
  async approve(user: User, workspace: Workspace, approvalId: string): Promise<{ chatId: string; server: string; tool: string; args: unknown; result: unknown }> {
    const row = await this.pending(user, workspace, approvalId);
    const server = (await this.db
      .selectFrom('aiMcpServers')
      .selectAll()
      .where('id', '=', row.serverId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst()) as McpServerRow | undefined;
    const result = server ? await this.call(server, row.toolName, (row.args as Record<string, unknown>) ?? {}) : { error: 'The MCP server is gone' };
    await this.db
      .updateTable('aiToolApprovals')
      .set({ status: 'approved', result: result as any, resolvedAt: new Date() })
      .where('id', '=', row.id)
      .execute();
    return { chatId: row.chatId, server: server?.name ?? '?', tool: row.toolName, args: row.args, result };
  }

  async deny(user: User, workspace: Workspace, approvalId: string): Promise<{ chatId: string; server: string; tool: string }> {
    const row = await this.pending(user, workspace, approvalId);
    await this.db.updateTable('aiToolApprovals').set({ status: 'denied', resolvedAt: new Date() }).where('id', '=', row.id).execute();
    const server = await this.db.selectFrom('aiMcpServers').select('name').where('id', '=', row.serverId).executeTakeFirst();
    return { chatId: row.chatId, server: server?.name ?? '?', tool: row.toolName };
  }

  // ---- internals ----------------------------------------------------------

  private async call(row: McpServerRow, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = this.servers.client(row);
    try {
      const result = await client.callTool(toolName, args);
      return flattenMcpResult(result);
    } catch (err: any) {
      this.logger.debug(`MCP ${row.name}/${toolName} failed: ${err?.message}`);
      return { error: String(err?.message ?? 'The tool failed').slice(0, 300) };
    } finally {
      await client.close();
    }
  }

  private async park(
    user: User,
    workspace: Workspace,
    chatId: string,
    row: McpServerRow,
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<unknown> {
    const approval = await this.db
      .insertInto('aiToolApprovals')
      .values({
        workspaceId: workspace.id,
        chatId,
        userId: user.id,
        serverId: row.id,
        toolCallId,
        toolName,
        args: args as any,
        status: 'pending',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      pendingApproval: { approvalId: approval.id, server: row.name, tool: toolName } satisfies PendingApproval,
      message: `This call changes something outside the wiki, so it waits for ${user.name}'s approval. Stop here and tell them what it would do; do not retry or pretend it ran.`,
    };
  }

  private async pending(user: User, workspace: Workspace, approvalId: string) {
    const row = await this.db
      .selectFrom('aiToolApprovals')
      .selectAll()
      .where('id', '=', approvalId)
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (!row) throw new Error('Approval not found');
    if (row.status !== 'pending') throw new Error(`This call was already ${row.status}`);
    if (Date.now() - new Date(row.createdAt as any).getTime() > APPROVAL_TTL_MS) {
      await this.db.updateTable('aiToolApprovals').set({ status: 'expired', resolvedAt: new Date() }).where('id', '=', row.id).execute();
      throw new Error('This approval expired; ask again in the chat');
    }
    return row;
  }
}

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'server'
  );
}

function describe(row: McpServerRow, def: McpToolInfo, needsApproval: boolean): string {
  const base = (def.description ?? def.name).trim().slice(0, 600);
  return `[${row.name}] ${base}${needsApproval ? ' (asks the user for approval before it runs)' : ''}`;
}

// The schema the server sends, with a sane root; providers reject empty or
// non-object roots.
function safeSchema(schema: Record<string, unknown> | undefined): any {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  if (s.type !== 'object') s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  delete s.$schema;
  return s;
}
