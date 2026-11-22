import * as http from 'http';
import { AddressInfo } from 'net';
import { NotionClient, NotionError, notionId, NOTION_VERSION } from './notion-client';

describe('notion client', () => {
  let server: http.Server;
  let base = '';
  const seen: Array<{ method: string; url: string; version: unknown; auth: unknown; body: string }> = [];
  let plan: Array<(req: http.IncomingMessage, res: http.ServerResponse, body: string) => void> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', version: req.headers['notion-version'], auth: req.headers.authorization, body });
        const next = plan.shift();
        if (next) return next(req, res, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"results":[],"has_more":false,"next_cursor":null}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    seen.length = 0;
    plan = [];
  });
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  it('writes ids the way Notion does', () => {
    expect(notionId('0000000100004000800000000000000a')).toBe('00000001-0000-4000-8000-00000000000a');
    expect(notionId('00000001-0000-4000-8000-00000000000A')).toBe('00000001-0000-4000-8000-00000000000a');
    expect(notionId('not-an-id')).toBe('not-an-id');
  });

  it('sends the token and the version, and ids with dashes', async () => {
    const client = new NotionClient('secret-token', base, 0);
    plan.push(json(200, { object: 'page', id: 'x' }));
    await client.page('0000000100004000800000000000000a');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/pages/00000001-0000-4000-8000-00000000000a', version: NOTION_VERSION, auth: 'Bearer secret-token' });
  });

  it('follows cursors until the list ends', async () => {
    const client = new NotionClient('t', base, 0);
    plan.push(json(200, { results: [{ id: 1 }, { id: 2 }], has_more: true, next_cursor: 'c1' }));
    plan.push(json(200, { results: [{ id: 3 }], has_more: false, next_cursor: null }));
    const rows = await client.rows('0000000100004000800000000000000a', 100);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(JSON.parse(seen[1].body)).toMatchObject({ start_cursor: 'c1', page_size: 100 });
    plan.push(json(200, { results: [{ id: 1 }], has_more: true, next_cursor: 'c1' }));
    plan.push(json(200, { results: [{ id: 2 }], has_more: false, next_cursor: null }));
    await client.children('0000000100004000800000000000000a');
    expect(seen[3].url).toContain('start_cursor=c1');
  });

  it('waits out a rate limit and a short outage', async () => {
    const client = new NotionClient('t', base, 0);
    plan.push(json(429, { code: 'rate_limited', message: 'slow' }, { 'retry-after': '0' }));
    plan.push(json(503, { code: 'service_unavailable' }));
    plan.push(json(200, { object: 'database', id: 'd' }));
    expect(await client.database('0000000100004000800000000000000a')).toMatchObject({ id: 'd' });
    expect(seen).toHaveLength(3);
  });

  it('does not retry a write after a server error, nor a blocked connection', async () => {
    const client = new NotionClient('t', base, 0);
    plan.push(json(500, { code: 'internal_server_error', message: 'boom' }));
    await expect(client.search('page', 10)).rejects.toBeInstanceOf(NotionError);
    expect(seen).toHaveLength(1);
    plan.push(json(429, { code: 'rate_limited', additional_data: { rate_limit_reason: 'public_api_request_blocked' } }));
    await expect(client.page('x')).rejects.toMatchObject({ status: 429 });
    expect(seen).toHaveLength(2);
  });

  it('says in words what went wrong', async () => {
    const client = new NotionClient('t', base, 0);
    plan.push(json(401, { code: 'unauthorized', message: 'API token is invalid.' }));
    await expect(client.search('page', 10)).rejects.toThrow(/did not accept the token/);
    plan.push(json(404, { code: 'object_not_found', message: 'nope' }));
    await expect(client.page('x')).rejects.toThrow(/shared with the connection/);
  });

  it('reads each view the list names and skips the ones it may not read', async () => {
    const client = new NotionClient('t', base, 0);
    plan.push(json(200, { results: [{ object: 'view', id: 'v1' }, { object: 'view', id: 'v2' }], has_more: false, next_cursor: null }));
    plan.push(json(200, { object: 'view', id: 'v1', name: 'Board', type: 'board' }));
    plan.push(json(404, { code: 'object_not_found' }));
    const views = await client.views('0000000100004000800000000000000a', 10);
    expect(views.map((v) => v.name)).toEqual(['Board']);
    expect(seen[0].url).toContain('database_id=00000001-0000-4000-8000-00000000000a');
  });
});
