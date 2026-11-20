// A small MCP client over Streamable HTTP: initialize, tools/list and
// tools/call as JSON-RPC POSTs, answers as JSON or as one SSE stream. Enough
// for calling tools from the chat without pulling the whole SDK in.
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 30_000;
const MAX_BODY = 512 * 1024;

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of result?.tools ?? []) {
        tools.push({
          name: String(t.name),
          description: t.description ? String(t.description) : undefined,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          annotations: t.annotations ?? undefined,
        });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent,
      isError: Boolean(result?.isError),
    };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'mcp-session-id': this.sessionId } });
    } catch {
      /* the session dies with its timeout */
    }
  }

  private async initialize() {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'docmore', version: '1.0.0' },
    });
    this.initialized = true;
    await this.notify('notifications/initialized');
  }

  private async notify(method: string) {
    const res = await this.post({ jsonrpc: '2.0', method });
    await res.arrayBuffer().catch(() => undefined);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    const type = res.headers.get('content-type') ?? '';
    const text = await readLimited(res);
    let message: any;
    if (type.includes('text/event-stream')) {
      message = parseSse(text).find((m) => m?.id === id);
    } else {
      try {
        const parsed = JSON.parse(text);
        message = Array.isArray(parsed) ? parsed.find((m) => m?.id === id) : parsed;
      } catch {
        throw new Error(`The MCP server answered with something that is not JSON (${res.status})`);
      }
    }
    if (!message) throw new Error(`The MCP server sent no answer to ${method}`);
    if (message.error) {
      throw new Error(String(message.error.message ?? `MCP error ${message.error.code ?? ''}`).slice(0, 300));
    }
    return message.result;
  }

  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL,
          ...this.headers,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      const session = res.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (res.status === 401 || res.status === 403) throw new Error('The MCP server rejected the credentials');
      if (res.status >= 400 && res.status !== 404) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`The MCP server answered ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      if (res.status === 404 && this.sessionId) {
        // the session expired: start over once
        this.sessionId = null;
        this.initialized = false;
        throw new Error('The MCP session expired; try again');
      }
      return res;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error('The MCP server did not answer in time');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimited(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY) throw new Error('The MCP server answered with too much data');
  return buf.toString('utf8');
}

function parseSse(text: string): any[] {
  const out: any[] = [];
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* keep-alive or partial */
    }
  }
  return out;
}

// What the model gets back: text blocks joined, structured content when there is one.
export function flattenMcpResult(result: McpCallResult, maxChars = 20_000): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const text = JSON.stringify(result.structuredContent);
    return text.length > maxChars ? { truncated: true, text: text.slice(0, maxChars) } : result.structuredContent;
  }
  const text = result.content
    .map((c) => (c.type === 'text' ? String(c.text ?? '') : `[${c.type}]`))
    .join('\n')
    .trim();
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
  return result.isError ? { error: clipped || 'The tool failed' } : { text: clipped };
}
