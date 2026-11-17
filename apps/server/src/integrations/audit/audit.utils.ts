import { isIP } from 'node:net';

// A year, like the enterprise edition's default. Admins change it from the
// audit page.
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 1;
export const MAX_AUDIT_RETENTION_DAYS = 3650;
export const AUDIT_INSERT_CHUNK = 500;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// The ip_address column is inet; anything Postgres would reject becomes
// null rather than failing the whole row. IPv4-mapped IPv6 is unwrapped.
export function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!ip) return null;
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) {
    ip = ip.slice(7);
  }
  return isIP(ip) ? ip : null;
}

export function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.min(
    MAX_AUDIT_RETENTION_DAYS,
    Math.max(MIN_AUDIT_RETENTION_DAYS, Math.round(days)),
  );
}

// Browsers send very long user agents; keep what is useful for a log row.
export function trimUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ua = value.trim();
  return ua ? ua.slice(0, 512) : null;
}
