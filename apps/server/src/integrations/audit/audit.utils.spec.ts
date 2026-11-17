import {
  clampRetentionDays,
  DEFAULT_AUDIT_RETENTION_DAYS,
  isUuid,
  MAX_AUDIT_RETENTION_DAYS,
  normalizeIp,
  trimUserAgent,
} from './audit.utils';

describe('audit.utils', () => {
  it('recognizes uuids only', () => {
    expect(isUuid('01a1e737-914d-759a-9cd3-f81d1e983143')).toBe(true);
    expect(isUuid('general')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('keeps valid addresses, unwraps mapped ipv4 and drops garbage', () => {
    expect(normalizeIp('192.168.1.10')).toBe('192.168.1.10');
    expect(normalizeIp('::ffff:10.0.0.7')).toBe('10.0.0.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });

  it('clamps retention to the allowed window', () => {
    expect(clampRetentionDays(0)).toBe(1);
    expect(clampRetentionDays(29.6)).toBe(30);
    expect(clampRetentionDays(99999)).toBe(MAX_AUDIT_RETENTION_DAYS);
    expect(clampRetentionDays(NaN)).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  it('trims user agents', () => {
    expect(trimUserAgent('  curl/8.7.1 ')).toBe('curl/8.7.1');
    expect(trimUserAgent('x'.repeat(600))).toHaveLength(512);
    expect(trimUserAgent(undefined)).toBeNull();
  });
});
