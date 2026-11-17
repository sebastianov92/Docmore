import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 8;
// No 0/O/1/I so a printed code reads back unambiguously.
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let code = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
      code += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
    }
    codes.add(code);
  }
  return [...codes];
}

export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function hashBackupCode(code: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(normalizeBackupCode(code))
    .digest('hex');
}

// Returns the stored hashes minus the one that matched, or null when none did.
export function consumeBackupCode(
  storedHashes: string[],
  code: string,
  secret: string,
): string[] | null {
  const candidate = Buffer.from(hashBackupCode(code, secret), 'hex');
  const index = storedHashes.findIndex((hash) => {
    const stored = Buffer.from(hash, 'hex');
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  });
  if (index === -1) {
    return null;
  }
  return storedHashes.filter((_, i) => i !== index);
}

export function looksLikeTotpCode(input: string): boolean {
  return /^\d{6}$/.test(input.trim());
}
