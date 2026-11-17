import {
  consumeBackupCode,
  generateBackupCodes,
  hashBackupCode,
  looksLikeTotpCode,
  normalizeBackupCode,
} from './mfa.codes';

describe('MFA backup codes', () => {
  it('generates ten distinct eight-character codes without ambiguous letters', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('accepts a code typed with dashes or lowercase', () => {
    expect(normalizeBackupCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(hashBackupCode('abcd efgh', 's')).toBe(hashBackupCode('ABCDEFGH', 's'));
  });

  it('burns a code once it is used', () => {
    const codes = generateBackupCodes(3);
    const stored = codes.map((code) => hashBackupCode(code, 'secret'));

    const afterFirst = consumeBackupCode(stored, codes[1], 'secret');
    expect(afterFirst).toHaveLength(2);
    expect(consumeBackupCode(afterFirst, codes[1], 'secret')).toBeNull();
    expect(consumeBackupCode(afterFirst, codes[0], 'secret')).toHaveLength(1);
  });

  it('rejects unknown codes and the wrong secret', () => {
    const codes = generateBackupCodes(2);
    const stored = codes.map((code) => hashBackupCode(code, 'secret'));
    expect(consumeBackupCode(stored, 'ZZZZZZZZ', 'secret')).toBeNull();
    expect(consumeBackupCode(stored, codes[0], 'other')).toBeNull();
  });

  it('tells authenticator codes from backup codes', () => {
    expect(looksLikeTotpCode('123456')).toBe(true);
    expect(looksLikeTotpCode(' 123456 ')).toBe(true);
    expect(looksLikeTotpCode('ABCD2345')).toBe(false);
    expect(looksLikeTotpCode('12345')).toBe(false);
  });
});
