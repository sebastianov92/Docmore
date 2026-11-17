import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { Public } from '../../common/decorators/public.decorator';
import { TokenService } from '../auth/services/token.service';
import { JwtType } from '../auth/dto/jwt-payload';
import { ApiKeyService } from '../api-key/api-key.service';
import { OAuthService } from '../oauth/oauth.service';
import { AiChatToolsService, ToolDefinition } from '../ai/chat/ai-chat-tools.service';

interface Principal {
  user: User;
  workspace: Workspace;
  scopes: string[];
  via: 'oauth' | 'api_key';
}

// The MCP server at /mcp (Streamable HTTP, stateless: one McpServer per
// request). Bearer tokens are OAuth access tokens from this server's own
// authorization server or, unless the workspace enforces OAuth, API keys.
// Tools are the same ones the AI chat uses, so permissions follow the user.
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly oauth: OAuthService,
    private readonly tools: AiChatToolsService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Public()
  @All()
  async handle(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const raw = (req.raw as any).workspace as Workspace | undefined;
    const workspace = raw ? await this.workspaceRepo.findById(raw.id) : null;
    const ai = ((workspace?.settings as any)?.ai ?? {}) as Record<string, any>;
    if (!workspace || ai.mcp !== true) {
      return res.status(404).send({ error: 'not_found', error_description: 'The MCP server is turned off for this workspace' });
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send();
    }

    const principal = await this.authenticate(req, workspace, ai.enforceMcpOauth === true);
    if (!principal) {
      const metadata = `${this.oauth.issuer()}/.well-known/oauth-protected-resource/mcp`;
      res.header('WWW-Authenticate', `Bearer realm="docmore", resource_metadata="${metadata}"`);
      return res.status(401).send({ error: 'unauthorized', error_description: 'A valid bearer token is required' });
    }

    if (req.method === 'DELETE') {
      // Stateless: there is no session to end.
      return res.status(200).send();
    }

    const { McpServer, WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
    const server = new McpServer({ name: 'docmore', version: '1.0.0' });
    const readOnly = !principal.scopes.includes('write') || ai.chatReadOnly === true;
    const definitions = await this.tools.definitions({
      user: principal.user,
      workspace: principal.workspace,
      readOnly,
    });
    for (const def of definitions) {
      this.register(server, def);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(toWebRequest(req));
      res.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-length') return;
        res.header(key, value);
      });
      const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
      return res.send(body);
    } catch (err: any) {
      this.logger.warn(`MCP request failed: ${err?.message}`);
      return res.status(500).send({ error: 'server_error', error_description: 'The MCP request failed' });
    } finally {
      await server.close().catch(() => undefined);
    }
  }

  private register(server: any, def: ToolDefinition) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.schema,
        annotations: { readOnlyHint: def.scope === 'read', destructiveHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const result = await def.execute(args ?? {});
        const failed = result && typeof result === 'object' && 'error' in (result as object);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(result && typeof result === 'object' ? { structuredContent: result as Record<string, unknown> } : {}),
          isError: Boolean(failed),
        };
      },
    );
  }

  private async authenticate(req: FastifyRequest, workspace: Workspace, enforceOAuth: boolean): Promise<Principal | null> {
    const header = req.headers.authorization;
    const token = header && /^bearer /i.test(header) ? header.slice(7).trim() : null;
    if (!token) return null;
    try {
      const payload = await this.tokens.verifyJwtOfTypes(token, [JwtType.OAUTH_ACCESS, JwtType.API_KEY]);
      if (payload.type === JwtType.OAUTH_ACCESS) {
        const result = await this.oauth.validateAccessToken(payload, { workspaceId: workspace.id });
        return { user: result.user, workspace: result.workspace, scopes: result.oauth.scopes, via: 'oauth' };
      }
      if (enforceOAuth) return null;
      const apiKeys = this.moduleRef.get(ApiKeyService, { strict: false });
      const result = await apiKeys.validateApiKey(payload);
      if (!result?.user || result.workspace?.id !== workspace.id) return null;
      const scopes: string[] = result.apiKey?.scopes ?? ['read'];
      return { user: result.user, workspace: result.workspace, scopes, via: 'api_key' };
    } catch (err: any) {
      this.logger.debug(`MCP bearer rejected: ${err?.message}`);
      return null;
    }
  }
}

// The SDK speaks web-standard Request/Response; Fastify already parsed the
// JSON body, so it goes back out as text.
function toWebRequest(req: FastifyRequest): Request {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  headers.delete('content-length');
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const body = hasBody ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})) : undefined;
  if (hasBody && !headers.get('content-type')) headers.set('content-type', 'application/json');
  return new Request(url, { method: req.method, headers, body });
}
