import {
  buildLoginErrorUrl,
  buildOidcCallbackUrl,
  identityFromClaims,
  isHttpIssuer,
  normalizeGroups,
  safeRedirectPath,
  toProviderView,
} from './sso.utils';

describe('sso.utils', () => {
  describe('safeRedirectPath', () => {
    it('keeps same-origin paths', () => {
      expect(safeRedirectPath('/s/general/p/page-1?x=1#h')).toBe(
        '/s/general/p/page-1?x=1#h',
      );
    });

    it('rejects anything that could leave the app', () => {
      for (const bad of [
        'https://evil.test',
        '//evil.test',
        '/\\evil.test',
        '/ok//../..//evil',
        'home',
        '',
        '/javascript:alert(1)',
        undefined,
        42,
      ]) {
        expect(safeRedirectPath(bad)).toBeNull();
      }
    });
  });

  describe('urls', () => {
    it('builds the callback from the app url without doubling slashes', () => {
      expect(buildOidcCallbackUrl('http://localhost:3100/', 'abc')).toBe(
        'http://localhost:3100/api/sso/oidc/abc/callback',
      );
    });

    it('encodes the error message into the login page url', () => {
      expect(buildLoginErrorUrl('http://localhost:3100', 'No & no')).toBe(
        'http://localhost:3100/login?ssoError=No+%26+no',
      );
    });

    it('detects plain http issuers', () => {
      expect(isHttpIssuer('http://idp.lan/realms/x')).toBe(true);
      expect(isHttpIssuer('https://idp.lan')).toBe(false);
      expect(isHttpIssuer('not a url')).toBe(false);
    });
  });

  describe('identityFromClaims', () => {
    it('needs a subject and an email', () => {
      expect(identityFromClaims(undefined)).toBeNull();
      expect(identityFromClaims({ sub: 'u1' })).toBeNull();
      expect(identityFromClaims({ sub: 'u1', email: 'nope' })).toBeNull();
    });

    it('normalizes email and picks the best display name', () => {
      expect(
        identityFromClaims({
          sub: 'u1',
          email: ' Bob@Example.COM ',
          given_name: 'Bob',
          family_name: 'Builder',
          email_verified: true,
          groups: ['docs', 'docs', 'ops'],
        }),
      ).toEqual({
        subject: 'u1',
        email: 'bob@example.com',
        name: 'Bob Builder',
        emailVerified: true,
        groups: ['docs', 'ops'],
      });
    });

    it('falls back to preferred_username and tolerates missing extras', () => {
      expect(
        identityFromClaims({
          sub: 'u2',
          email: 'a@b.co',
          preferred_username: 'alice',
        }),
      ).toEqual({
        subject: 'u2',
        email: 'a@b.co',
        name: 'alice',
        emailVerified: null,
        groups: [],
      });
    });
  });

  describe('normalizeGroups', () => {
    it('accepts arrays and delimited strings, case-insensitively distinct', () => {
      expect(normalizeGroups(['Ops', 'ops', ' docs '])).toEqual(['Ops', 'docs']);
      expect(normalizeGroups('a b  c')).toEqual(['a', 'b', 'c']);
      expect(normalizeGroups('a, b,c')).toEqual(['a', 'b', 'c']);
      expect(normalizeGroups(null)).toEqual([]);
      expect(normalizeGroups([1, '', null])).toEqual([]);
    });

    it('caps the number of groups', () => {
      const many = Array.from({ length: 80 }, (_, i) => `g${i}`);
      expect(normalizeGroups(many)).toHaveLength(50);
    });
  });

  describe('toProviderView', () => {
    it('replaces the secret with a flag', () => {
      expect(
        toProviderView({ id: 'p', oidcClientSecret: 'enc:...' } as any),
      ).toEqual({ id: 'p', hasOidcClientSecret: true });
      expect(toProviderView({ id: 'p', oidcClientSecret: null } as any)).toEqual(
        { id: 'p', hasOidcClientSecret: false },
      );
      expect(
        toProviderView({ id: 'p', hasOidcClientSecret: true } as any),
      ).toEqual({ id: 'p', hasOidcClientSecret: true });
    });
  });
});
