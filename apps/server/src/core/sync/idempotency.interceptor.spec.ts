import { ConflictException, BadRequestException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

type Stored = { route: string; response: { value: unknown } };

function fakeDb(existing: Stored | undefined) {
  const inserted: any[] = [];
  const db: any = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({ executeTakeFirst: async () => existing }),
        }),
      }),
    }),
    insertInto: () => ({
      values: (row: any) => {
        inserted.push(row);
        return { onConflict: () => ({ execute: async () => undefined }) };
      },
    }),
  };
  return { db, inserted };
}

function contextFor(opts: { key?: string; method?: string; url?: string; user?: boolean }) {
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers['idempotency-key'] = opts.key;
  const replyHeaders: Record<string, string> = {};
  const req = {
    headers,
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/pages/create',
    user: opts.user === false ? undefined : { user: { id: 'u1' }, workspace: { id: 'w1' } },
  };
  const res = { header: (name: string, value: string) => (replyHeaders[name] = value) };
  const context: any = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  };
  return { context, replyHeaders };
}

describe('IdempotencyInterceptor', () => {
  it('runs the handler and stores the answer the first time', async () => {
    const { db, inserted } = fakeDb(undefined);
    const interceptor = new IdempotencyInterceptor(db);
    const { context } = contextFor({ key: 'abc-1' });
    const handler = { handle: jest.fn(() => of({ id: 'p1' })) };

    const result = await firstValueFrom(interceptor.intercept(context, handler));

    expect(result).toEqual({ id: 'p1' });
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: 'u1',
      workspaceId: 'w1',
      key: 'abc-1',
      route: '/api/pages/create',
      response: { value: { id: 'p1' } },
    });
  });

  it('answers a repeat from the stored answer without running again', async () => {
    const { db, inserted } = fakeDb({ route: '/api/pages/create', response: { value: { id: 'p1' } } });
    const interceptor = new IdempotencyInterceptor(db);
    const { context, replyHeaders } = contextFor({ key: 'abc-1' });
    const handler = { handle: jest.fn(() => of({ id: 'other' })) };

    const result = await firstValueFrom(interceptor.intercept(context, handler));

    expect(result).toEqual({ id: 'p1' });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(replyHeaders['Idempotent-Replayed']).toBe('true');
  });

  it('refuses a key that was used for another route', async () => {
    const { db } = fakeDb({ route: '/api/pages/update', response: { value: {} } });
    const interceptor = new IdempotencyInterceptor(db);
    const { context } = contextFor({ key: 'abc-1' });

    await expect(
      firstValueFrom(interceptor.intercept(context, { handle: () => of({}) })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a malformed key', () => {
    const { db } = fakeDb(undefined);
    const interceptor = new IdempotencyInterceptor(db);
    const { context } = contextFor({ key: 'has spaces!' });

    expect(() => interceptor.intercept(context, { handle: () => of({}) })).toThrow(BadRequestException);
  });

  it('stays out of the way without the header, without a person, and for reads', async () => {
    const { db, inserted } = fakeDb(undefined);
    const interceptor = new IdempotencyInterceptor(db);
    for (const opts of [{}, { key: 'abc', user: false }, { key: 'abc', method: 'GET' }]) {
      const { context } = contextFor(opts);
      const handler = { handle: jest.fn(() => of('x')) };
      expect(await firstValueFrom(interceptor.intercept(context, handler))).toBe('x');
      expect(handler.handle).toHaveBeenCalledTimes(1);
    }
    expect(inserted).toHaveLength(0);
  });
});
