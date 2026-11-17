// Shared rules of page verification: expiry maths, derived status and
// change detection. Pure functions so the spec can pin them down.

export type VerificationType = 'expiring' | 'qms';
export type ExpirationMode = 'period' | 'fixed' | 'indefinite';
export type PeriodUnit = 'day' | 'week' | 'month' | 'year';
export type VerificationStatus =
  | 'verified'
  | 'expiring'
  | 'expired'
  | 'invalidated'
  | 'draft'
  | 'in_approval'
  | 'approved'
  | 'obsolete'
  | 'none';

export const MAX_VERIFIERS = 5;
export const PERIOD_AMOUNT_MIN = 1;
export const PERIOD_UNIT_DAYS: Record<PeriodUnit, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};
export const PERIOD_UNIT_MAX_AMOUNT: Record<PeriodUnit, number> = {
  day: 3650,
  week: 520,
  month: 120,
  year: 20,
};
// Verifiers hear about an upcoming expiry this long before it, capped at
// half the period so a one-week cycle does not nag from day one.
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidPeriod(amount: unknown, unit: unknown): unit is PeriodUnit {
  return (
    typeof unit === 'string' &&
    unit in PERIOD_UNIT_DAYS &&
    Number.isInteger(amount) &&
    (amount as number) >= PERIOD_AMOUNT_MIN &&
    (amount as number) <= PERIOD_UNIT_MAX_AMOUNT[unit as PeriodUnit]
  );
}

export function periodDays(amount: number, unit: PeriodUnit): number {
  return amount * PERIOD_UNIT_DAYS[unit];
}

export interface ExpirationSettings {
  mode: ExpirationMode;
  periodAmount: number | null;
  periodUnit: PeriodUnit | null;
  fixedExpiresAt: Date | null;
}

// When a verification made at `from` runs out under these settings.
export function computeExpiresAt(settings: ExpirationSettings, from: Date): Date | null {
  if (settings.mode === 'indefinite') return null;
  if (settings.mode === 'fixed') return settings.fixedExpiresAt;
  if (settings.periodAmount && settings.periodUnit) {
    return new Date(
      from.getTime() + periodDays(settings.periodAmount, settings.periodUnit) * DAY_MS,
    );
  }
  return null;
}

export function warningWindowMs(settings: Pick<ExpirationSettings, 'mode' | 'periodAmount' | 'periodUnit'>): number {
  const full = EXPIRY_WARNING_DAYS * DAY_MS;
  if (settings.mode === 'period' && settings.periodAmount && settings.periodUnit) {
    const half = (periodDays(settings.periodAmount, settings.periodUnit) * DAY_MS) / 2;
    return Math.min(full, half);
  }
  return full;
}

export interface StatusInput {
  type: string;
  status: string | null;
  mode: string | null;
  periodAmount: number | null;
  periodUnit: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  invalidatedAt: Date | null;
}

// The approval workflow stores its state; the recurring one is read off the
// dates, so an expiry never needs a job to flip it.
export function deriveStatus(row: StatusInput | null | undefined, now: Date): VerificationStatus {
  if (!row) return 'none';
  if (row.type === 'qms') {
    return (row.status as VerificationStatus) ?? 'draft';
  }
  if (row.invalidatedAt) return 'invalidated';
  if (!row.verifiedAt) return 'none';
  if (row.expiresAt) {
    const left = row.expiresAt.getTime() - now.getTime();
    if (left <= 0) return 'expired';
    const window = warningWindowMs({
      mode: (row.mode as ExpirationMode) ?? 'period',
      periodAmount: row.periodAmount,
      periodUnit: row.periodUnit as PeriodUnit | null,
    });
    if (left <= window) return 'expiring';
  }
  return 'verified';
}

export const LOCKED_STATUSES: VerificationStatus[] = [
  'verified',
  'expiring',
  'approved',
  'in_approval',
];

// Whether the page differs from a recorded baseline. Titles compare
// whitespace-insensitively; content compares structurally, so a reload
// that reorders nothing is not a change.
export function hasPageChanged(
  baseline: { title: string | null; content: unknown },
  current: { title: string | null; content: unknown },
): boolean {
  const normTitle = (t: string | null) => (t ?? '').replace(/\s+/g, ' ').trim();
  if (normTitle(baseline.title) !== normTitle(current.title)) return true;
  return stableJson(baseline.content) !== stableJson(current.content);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc: Record<string, unknown>, k) => {
          acc[k] = v[k];
          return acc;
        }, {});
    }
    return v;
  });
}

export function uniqueIds(ids: string[] | undefined | null): string[] {
  return [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id))];
}
