import { AuthProvider } from '@docmost/db/types/entity.types';

export const SSO_STATE_COOKIE = 'ssoState';
export const SSO_STATE_COOKIE_PATH = '/api/sso';
export const SSO_STATE_TTL_SECONDS = 10 * 60;
export const SSO_ERROR_PARAM = 'ssoError';

// Mirrors the client-side safeRedirectPath: a same-origin path or nothing.
export function safeRedirectPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > 2048) return null;
  if (/[\s\\]|\p{C}/u.test(input)) return null;
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  if (input.toLowerCase().includes('://')) return null;
  if (/^\/[a-z][a-z0-9+\-.]*:/i.test(input)) return null;
  try {
    const resolved = new URL(input, 'http://docmore.invalid');
    if (resolved.host !== 'docmore.invalid') return null;
    if (resolved.pathname.startsWith('//')) return null;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return null;
  }
}

export function buildOidcCallbackUrl(appUrl: string, providerId: string) {
  return `${appUrl.replace(/\/+$/, '')}/api/sso/oidc/${providerId}/callback`;
}

export function buildLoginErrorUrl(appUrl: string, message: string) {
  const url = new URL('/login', appUrl);
  url.searchParams.set(SSO_ERROR_PARAM, message);
  return url.toString();
}

export interface SsoIdentity {
  subject: string;
  email: string;
  name: string | null;
  emailVerified: boolean | null;
  groups: string[];
}

// Pulls what Docmore needs out of ID token / userinfo claims. Returns null
// when there is no usable email, since accounts are keyed by it.
export function identityFromClaims(
  claims: Record<string, unknown> | undefined,
): SsoIdentity | null {
  if (!claims) return null;
  const subject = asString(claims.sub);
  const email = asString(claims.email)?.trim().toLowerCase();
  if (!subject || !email || !email.includes('@')) return null;

  const name =
    asString(claims.name)?.trim() ||
    [asString(claims.given_name), asString(claims.family_name)]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    asString(claims.preferred_username)?.trim() ||
    null;

  return {
    subject,
    email,
    name: name && name.length > 0 ? name.slice(0, 50) : null,
    emailVerified:
      typeof claims.email_verified === 'boolean' ? claims.email_verified : null,
    groups: normalizeGroups(claims.groups),
  };
}

export const MAX_SYNCED_GROUPS = 50;
export const MAX_GROUP_NAME_LENGTH = 100;

// Identity providers send `groups` as an array, a single string, or a
// space-separated string. Keep distinct, non-empty names only.
export function normalizeGroups(value: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string') {
    raw = value.includes(',') ? value.split(',') : value.split(/\s+/);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const name = asString(item)?.trim().slice(0, MAX_GROUP_NAME_LENGTH);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= MAX_SYNCED_GROUPS) break;
  }
  return result;
}

export function isHttpIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).protocol === 'http:';
  } catch {
    return false;
  }
}

// What admins see. The client secret never leaves the server; the UI only
// learns whether one is stored (the repo computes the flag, rows fetched
// with the secret fall back to its presence).
export function toProviderView(
  provider: Partial<AuthProvider> & {
    oidcClientSecret?: string | null;
    hasOidcClientSecret?: boolean;
  },
) {
  const { oidcClientSecret, hasOidcClientSecret, ...rest } = provider;
  return {
    ...rest,
    hasOidcClientSecret: hasOidcClientSecret ?? !!oidcClientSecret,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
