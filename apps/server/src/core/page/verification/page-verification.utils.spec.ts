import {
  computeExpiresAt,
  deriveStatus,
  hasPageChanged,
  isValidPeriod,
  stableJson,
  uniqueIds,
  warningWindowMs,
} from './page-verification.utils';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-11-17T12:00:00Z');

const expiring = (over: Partial<Parameters<typeof deriveStatus>[0]> = {}) => ({
  type: 'expiring',
  status: null,
  mode: 'period',
  periodAmount: 1,
  periodUnit: 'month',
  verifiedAt: new Date(now.getTime() - 10 * DAY),
  expiresAt: new Date(now.getTime() + 20 * DAY),
  invalidatedAt: null,
  ...over,
});

describe('page-verification.utils', () => {
  it('validates periods against the unit caps', () => {
    expect(isValidPeriod(1, 'day')).toBe(true);
    expect(isValidPeriod(20, 'year')).toBe(true);
    expect(isValidPeriod(21, 'year')).toBe(false);
    expect(isValidPeriod(0, 'week')).toBe(false);
    expect(isValidPeriod(1.5, 'month')).toBe(false);
    expect(isValidPeriod(1, 'fortnight')).toBe(false);
  });

  it('computes the expiry for each mode', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(
      computeExpiresAt({ mode: 'period', periodAmount: 2, periodUnit: 'week', fixedExpiresAt: null }, from),
    ).toEqual(new Date('2026-01-15T00:00:00Z'));
    const fixed = new Date('2027-03-01T00:00:00Z');
    expect(
      computeExpiresAt({ mode: 'fixed', periodAmount: null, periodUnit: null, fixedExpiresAt: fixed }, from),
    ).toEqual(fixed);
    expect(
      computeExpiresAt({ mode: 'indefinite', periodAmount: null, periodUnit: null, fixedExpiresAt: null }, from),
    ).toBeNull();
  });

  it('warns a week ahead, or half the period when that is shorter', () => {
    expect(warningWindowMs({ mode: 'period', periodAmount: 1, periodUnit: 'year' })).toBe(7 * DAY);
    expect(warningWindowMs({ mode: 'period', periodAmount: 4, periodUnit: 'day' })).toBe(2 * DAY);
    expect(warningWindowMs({ mode: 'fixed', periodAmount: null, periodUnit: null })).toBe(7 * DAY);
  });

  it('derives the recurring status from the dates', () => {
    expect(deriveStatus(null, now)).toBe('none');
    expect(deriveStatus(expiring(), now)).toBe('verified');
    expect(deriveStatus(expiring({ expiresAt: new Date(now.getTime() + 3 * DAY) }), now)).toBe('expiring');
    expect(deriveStatus(expiring({ expiresAt: new Date(now.getTime() - DAY) }), now)).toBe('expired');
    expect(deriveStatus(expiring({ invalidatedAt: now }), now)).toBe('invalidated');
    expect(deriveStatus(expiring({ mode: 'indefinite', expiresAt: null }), now)).toBe('verified');
  });

  it('reads the approval status as stored', () => {
    expect(deriveStatus(expiring({ type: 'qms', status: 'in_approval' }), now)).toBe('in_approval');
    expect(deriveStatus(expiring({ type: 'qms', status: null }), now)).toBe('draft');
  });

  it('spots real changes and ignores noise', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { a: 1, b: 2 } }] };
    const same = { type: 'doc', content: [{ type: 'paragraph', attrs: { b: 2, a: 1 } }] };
    expect(hasPageChanged({ title: 'A  title', content: doc }, { title: 'A title ', content: same })).toBe(false);
    expect(hasPageChanged({ title: 'A', content: doc }, { title: 'B', content: doc })).toBe(true);
    expect(
      hasPageChanged({ title: 'A', content: doc }, { title: 'A', content: { type: 'doc', content: [] } }),
    ).toBe(true);
    expect(stableJson([{ b: 1, a: [2, { d: 1, c: 2 }] }])).toBe('[{"a":[2,{"c":2,"d":1}],"b":1}]');
  });

  it('dedupes verifier ids', () => {
    expect(uniqueIds(['a', 'b', 'a', '', undefined as any])).toEqual(['a', 'b']);
    expect(uniqueIds(undefined)).toEqual([]);
  });
});
