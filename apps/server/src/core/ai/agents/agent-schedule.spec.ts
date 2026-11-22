import { dayLabel, instantOf, nextRun, partsIn, readSchedule } from './agent-schedule';

const iso = (d: Date) => d.toISOString();

describe('agent schedule', () => {
  it('reads a schedule and refuses nonsense', () => {
    expect(readSchedule({ kind: 'daily', hour: 8, minute: 30, timezone: 'America/Guayaquil', weekdays: [1] })).toEqual({
      kind: 'daily',
      hour: 8,
      minute: 30,
      timezone: 'America/Guayaquil',
    });
    expect(readSchedule({ kind: 'weekly', hour: 9, timezone: 'UTC', weekdays: [5, 1, 1, 9, 'x'] })).toEqual({
      kind: 'weekly',
      hour: 9,
      minute: 0,
      timezone: 'UTC',
      weekdays: [1, 5],
    });
    expect(readSchedule({ kind: 'monthly', hour: 0, minute: 0, timezone: 'Europe/Madrid', dayOfMonth: 28 }).dayOfMonth).toBe(28);
    expect(() => readSchedule({ kind: 'hourly', hour: 1, timezone: 'UTC' })).toThrow();
    expect(() => readSchedule({ kind: 'daily', hour: 24, timezone: 'UTC' })).toThrow();
    expect(() => readSchedule({ kind: 'daily', hour: 8, minute: 60, timezone: 'UTC' })).toThrow();
    expect(() => readSchedule({ kind: 'daily', hour: 8, timezone: 'Mars/Olympus' })).toThrow();
    expect(() => readSchedule({ kind: 'weekly', hour: 8, timezone: 'UTC', weekdays: [] })).toThrow();
    expect(() => readSchedule({ kind: 'monthly', hour: 8, timezone: 'UTC', dayOfMonth: 31 })).toThrow();
    expect(() => readSchedule(null)).toThrow();
  });

  it('knows the clock of a zone', () => {
    // 2026-11-23 01:30 UTC is still Sunday the 22nd, 20:30, in Guayaquil (UTC-5)
    expect(partsIn(new Date('2026-11-23T01:30:00Z'), 'America/Guayaquil')).toEqual({ year: 2026, month: 11, day: 22, hour: 20, minute: 30, weekday: 0 });
    expect(iso(instantOf(2026, 11, 23, 8, 0, 'America/Guayaquil'))).toBe('2026-11-23T13:00:00.000Z');
    expect(dayLabel(new Date('2026-11-23T01:30:00Z'), 'America/Guayaquil')).toBe('2026-11-22');
    expect(partsIn(new Date('2026-07-01T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  it('daily: today when the hour is still ahead, else tomorrow', () => {
    const s = { kind: 'daily' as const, hour: 8, minute: 0, timezone: 'America/Guayaquil' };
    expect(iso(nextRun(s, new Date('2026-11-22T12:00:00Z')))).toBe('2026-11-22T13:00:00.000Z'); // 07:00 there
    expect(iso(nextRun(s, new Date('2026-11-22T13:00:00Z')))).toBe('2026-11-23T13:00:00.000Z'); // exactly 08:00: the next one
    expect(iso(nextRun(s, new Date('2026-11-22T20:00:00Z')))).toBe('2026-11-23T13:00:00.000Z');
  });

  it('weekly: the next of the chosen days', () => {
    // Mondays and Thursdays at 09:15 in Madrid (UTC+1 in winter); 2026-11-22 is a Sunday
    const s = { kind: 'weekly' as const, hour: 9, minute: 15, weekdays: [1, 4], timezone: 'Europe/Madrid' };
    expect(iso(nextRun(s, new Date('2026-11-22T10:00:00Z')))).toBe('2026-11-23T08:15:00.000Z');
    expect(iso(nextRun(s, new Date('2026-11-23T08:15:00Z')))).toBe('2026-11-26T08:15:00.000Z');
    expect(iso(nextRun(s, new Date('2026-11-26T09:00:00Z')))).toBe('2026-11-30T08:15:00.000Z');
  });

  it('monthly: that day of this month or the next', () => {
    const s = { kind: 'monthly' as const, hour: 7, minute: 0, dayOfMonth: 1, timezone: 'UTC' };
    expect(iso(nextRun(s, new Date('2026-11-22T00:00:00Z')))).toBe('2026-12-01T07:00:00.000Z');
    expect(iso(nextRun(s, new Date('2026-12-01T07:00:00Z')))).toBe('2027-01-01T07:00:00.000Z');
    expect(iso(nextRun({ ...s, dayOfMonth: 28 }, new Date('2027-02-01T00:00:00Z')))).toBe('2027-02-28T07:00:00.000Z');
  });

  it('follows summer time', () => {
    // Madrid: 08:00 is 07:00 UTC in winter and 06:00 UTC in summer; the clocks change on 2027-03-28
    const s = { kind: 'daily' as const, hour: 8, minute: 0, timezone: 'Europe/Madrid' };
    expect(iso(nextRun(s, new Date('2027-03-27T12:00:00Z')))).toBe('2027-03-28T06:00:00.000Z');
    expect(iso(nextRun(s, new Date('2027-03-26T12:00:00Z')))).toBe('2027-03-27T07:00:00.000Z');
    // 02:30 does not exist that night: the run still happens once, not twice and not never
    const skipped = { kind: 'daily' as const, hour: 2, minute: 30, timezone: 'Europe/Madrid' };
    const first = nextRun(skipped, new Date('2027-03-27T12:00:00Z'));
    const second = nextRun(skipped, first);
    expect(first.getTime()).toBeGreaterThan(new Date('2027-03-27T23:00:00Z').getTime());
    expect(first.getTime()).toBeLessThan(new Date('2027-03-28T03:00:00Z').getTime());
    expect(iso(second)).toBe('2027-03-29T00:30:00.000Z');
  });
});
