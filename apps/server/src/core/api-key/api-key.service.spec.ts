import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiKeyService, normalizeScopes, readScopes } from './api-key.service';

describe('API key scopes', () => {
  it('defaults to read and write', () => {
    expect(normalizeScopes(undefined)).toEqual(['read', 'write']);
  });

  it('keeps read-only keys read-only', () => {
    expect(normalizeScopes(['read'])).toEqual(['read']);
  });

  it('gives write keys read access too', () => {
    expect(normalizeScopes(['write'])).toEqual(['read', 'write']);
  });

  it('refuses a key with no usable scope', () => {
    expect(() => normalizeScopes(['nope' as any])).toThrow(BadRequestException);
  });

  it('reads scopes stored as jsonb or as text', () => {
    expect(readScopes(['read'])).toEqual(['read']);
    expect(readScopes('["read","write"]')).toEqual(['read', 'write']);
    expect(readScopes('garbage')).toEqual([]);
    expect(readScopes(null)).toEqual([]);
  });
});

describe('ApiKeyService.validateApiKey', () => {
  const payload = {
    sub: 'user-1',
    workspaceId: 'ws-1',
    apiKeyId: 'key-1',
    type: 'api_key' as const,
  };

  function makeService(key: any) {
    const apiKeyRepo = {
      findById: jest.fn(async () => key),
      touchLastUsed: jest.fn(async () => undefined),
    };
    const userRepo = {
      findById: jest.fn(async () => ({ id: 'user-1', deactivatedAt: null })),
    };
    const workspaceRepo = { findById: jest.fn(async () => ({ id: 'ws-1' })) };
    const service = new ApiKeyService(
      apiKeyRepo as any,
      userRepo as any,
      workspaceRepo as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
    );
    return { service, apiKeyRepo };
  }

  it('returns the user, workspace and scopes for a live key', async () => {
    const { service, apiKeyRepo } = makeService({
      id: 'key-1',
      creatorId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ['read'],
    });

    const result = await service.validateApiKey(payload);

    expect(result.user.id).toBe('user-1');
    expect(result.workspace.id).toBe('ws-1');
    expect(result.apiKey).toEqual({ id: 'key-1', scopes: ['read'] });
    expect(apiKeyRepo.touchLastUsed).toHaveBeenCalledWith('key-1');
  });

  it('rejects a revoked key', async () => {
    const { service } = makeService(undefined);
    await expect(service.validateApiKey(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired key', async () => {
    const { service } = makeService({
      id: 'key-1',
      creatorId: 'user-1',
      expiresAt: new Date(Date.now() - 1000),
      scopes: ['read', 'write'],
    });
    await expect(service.validateApiKey(payload)).rejects.toThrow(
      'API key has expired',
    );
  });

  it('rejects a key whose owner does not match the token', async () => {
    const { service } = makeService({
      id: 'key-1',
      creatorId: 'someone-else',
      expiresAt: null,
      scopes: ['read', 'write'],
    });
    await expect(service.validateApiKey(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
