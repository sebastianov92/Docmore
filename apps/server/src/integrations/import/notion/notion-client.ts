// The few calls of the Notion public API the import needs, paced under its
// rate limit and retried the way its docs ask.

export const NOTION_VERSION = '2026-03-11';
const DEFAULT_BASE = 'https://api.notion.com';
// about three requests a second per connection
const MIN_GAP_MS = 340;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

function friendly(status: number, code: string | null, message: string): string {
  if (status === 401) return 'Notion did not accept the token. Copy the secret of the connection again.';
  if (status === 403) return 'The connection is not allowed to read that. Give it "Read content" in Notion.';
  if (status === 404) return 'Notion did not find it: the page has to be shared with the connection.';
  if (status === 429) return 'Notion is limiting requests right now. Try again in a few minutes.';
  return `Notion answered ${status}${code ? ` (${code})` : ''}${message ? `: ${message.slice(0, 200)}` : ''}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// An id the way Notion writes it: 8-4-4-4-12, whatever form it came in.
export function notionId(id: string): string {
  const hex = String(id).replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : String(id);
}

export class NotionClient {
  private last = 0;
  requests = 0;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string = (process.env.NOTION_API_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    private readonly gapMs: number = process.env.NOTION_API_URL ? 0 : MIN_GAP_MS,
  ) {}

  async request(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': NOTION_VERSION,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err: any) {
        if (attempt < MAX_RETRIES && method === 'GET') {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new NotionError(`Could not reach Notion: ${err?.cause?.message ?? err?.message ?? 'no answer'}`, 0, null);
      }
      if (res.ok) return res.json();
      const data: any = await res.json().catch(() => ({}));
      const code = typeof data?.code === 'string' ? data.code : null;
      const blocked = data?.additional_data?.rate_limit_reason === 'public_api_request_blocked';
      const retriable = ((res.status === 429 || res.status === 529) && !blocked) || (res.status >= 500 && res.status !== 529 && method === 'GET');
      if (retriable && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw new NotionError(friendly(res.status, code, String(data?.message ?? '')), res.status, code);
    }
  }

  // Every page of a list, up to a cap.
  async all(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string | number | undefined>, cap = 10_000): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const page =
        method === 'GET'
          ? await this.request('GET', path, undefined, { ...query, page_size: 100, start_cursor: cursor })
          : await this.request('POST', path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, query);
      out.push(...(page?.results ?? []));
      cursor = page?.has_more && page?.next_cursor ? String(page.next_cursor) : undefined;
    } while (cursor && out.length < cap);
    return out.slice(0, cap);
  }

  search(kind: 'page' | 'data_source', cap: number): Promise<any[]> {
    return this.all('POST', '/v1/search', { filter: { property: 'object', value: kind } }, undefined, cap);
  }

  children(blockId: string): Promise<any[]> {
    return this.all('GET', `/v1/blocks/${notionId(blockId)}/children`, undefined, undefined, 5_000);
  }

  // One block: its parent says where it sits.
  block(id: string): Promise<any> {
    return this.request('GET', `/v1/blocks/${notionId(id)}`);
  }

  page(id: string): Promise<any> {
    return this.request('GET', `/v1/pages/${notionId(id)}`);
  }

  database(id: string): Promise<any> {
    return this.request('GET', `/v1/databases/${notionId(id)}`);
  }

  dataSource(id: string): Promise<any> {
    return this.request('GET', `/v1/data_sources/${notionId(id)}`);
  }

  rows(dataSourceId: string, cap: number): Promise<any[]> {
    return this.all('POST', `/v1/data_sources/${notionId(dataSourceId)}/query`, {}, undefined, cap);
  }

  // The list only names the views: each is read on its own.
  async views(databaseId: string, cap: number): Promise<any[]> {
    const refs = await this.all('GET', '/v1/views', undefined, { database_id: notionId(databaseId) }, cap);
    const out: any[] = [];
    for (const ref of refs) {
      if (!ref?.id) continue;
      try {
        out.push(await this.request('GET', `/v1/views/${notionId(ref.id)}`));
      } catch {
        // a view the connection cannot read is left out
      }
    }
    return out;
  }
}
