import { buildIcs, dayIn, escapeText, fold, nextDay, wholeDay } from './base-ics';
import { cellText, dateProperty, toEvent } from './base-calendar-feed.service';

describe('base calendar feed', () => {
  it('escapes what the format reserves', () => {
    expect(escapeText('a, b; c\\d\nnext')).toBe('a\\, b\\; c\\\\d\\nnext');
  });

  it('folds long lines at 75 octets without cutting a character', () => {
    const line = 'SUMMARY:' + 'ñ'.repeat(80);
    const folded = fold(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const [i, part] of folded.entries()) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
      if (i > 0) expect(part.startsWith(' ')).toBe(true);
    }
    expect(folded.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('gives a whole day the date its writer saw', () => {
    // typed as a plain day: midnight of UTC, whatever the zone
    expect(wholeDay(new Date('2026-12-01T00:00:00.000Z'), 'America/Guayaquil')).toBe('20261201');
    // picked on a calendar in Guayaquil: local midnight is 05:00 UTC
    expect(wholeDay(new Date('2026-12-01T05:00:00.000Z'), 'America/Guayaquil')).toBe('20261201');
    // picked in Madrid: local midnight is still the day before in UTC
    expect(wholeDay(new Date('2026-11-30T23:00:00.000Z'), 'Europe/Madrid')).toBe('20261201');
    expect(dayIn(new Date('2026-11-30T23:00:00.000Z'), 'not/a-zone')).toBe('20261130');
    expect(nextDay('20261231')).toBe('20270101');
  });

  it('writes whole-day and timed events', () => {
    const ics = buildIcs({
      name: 'Launch · Calendar',
      host: 'docs.example.com',
      now: new Date('2026-11-22T10:00:00.000Z'),
      events: [
        { uid: 'r1', title: 'Demo, internal', start: new Date('2026-12-01T05:00:00.000Z'), allDay: true, day: '20261201' },
        {
          uid: 'r2',
          title: 'Call',
          start: new Date('2026-12-02T15:30:00.000Z'),
          allDay: false,
          updatedAt: new Date('2026-11-20T08:00:00.000Z'),
          url: 'https://docs.example.com/s/general/p/abc',
          description: 'Owner: Ana\nStatus: Open',
        },
      ],
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:Launch · Calendar\r\n');
    expect(ics).toContain('UID:r1@docs.example.com\r\n');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202\r\n');
    expect(ics).toContain('SUMMARY:Demo\\, internal\r\n');
    expect(ics).toContain('DTSTART:20261202T153000Z\r\nDTEND:20261202T163000Z\r\n');
    expect(ics).toContain('LAST-MODIFIED:20261120T080000Z\r\n');
    expect(ics).toContain('DESCRIPTION:Owner: Ana\\nStatus: Open\r\n');
    expect(ics).toContain('URL:https://docs.example.com/s/general/p/abc\r\n');
    expect(ics.split('BEGIN:VEVENT').length - 1).toBe(2);
    expect(ics.includes('\n') && !/[^\r]\n/.test(ics)).toBe(true);
  });

  it('turns a row into an event by the date of the view', () => {
    const title = { id: 'p1', name: 'Name', type: 'text', isPrimary: true };
    const due = { id: 'p2', name: 'Due', type: 'date', typeOptions: {} };
    const at = { id: 'p3', name: 'At', type: 'date', typeOptions: { includeTime: true } };
    const status = { id: 'p4', name: 'Status', type: 'status', typeOptions: { choices: [{ id: 'c1', name: 'Open' }] } };
    const tags = { id: 'p5', name: 'Tags', type: 'multiSelect', typeOptions: { choices: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }] } };
    const row = {
      id: 'r1',
      cells: { p1: ' Ship it ', p2: '2026-12-01T05:00:00.000Z', p3: '2026-12-02T15:30:00.000Z', p4: 'c1', p5: ['t1', 't2', 'gone'] },
      updatedAt: '2026-11-20T08:00:00.000Z',
    };
    expect(dateProperty([title, due, at], undefined)?.id).toBe('p2');
    expect(dateProperty([title, due, at], 'p3')?.id).toBe('p3');
    expect(dateProperty([title, due, at], 'p1')?.id).toBe('p2');
    expect(dateProperty([title], undefined)).toBeUndefined();

    const day = toEvent(row, due, title, [status, tags], 'America/Guayaquil', 'https://x/s/g/p/a')!;
    expect(day).toMatchObject({ uid: 'r1', title: 'Ship it', allDay: true, day: '20261201', description: 'Status: Open\nTags: A, B' });
    const timed = toEvent(row, at, title, [], 'America/Guayaquil')!;
    expect(timed.allDay).toBe(false);
    expect(timed.start.toISOString()).toBe('2026-12-02T15:30:00.000Z');
    expect(toEvent({ id: 'r2', cells: {} }, due, title, [], null)).toBeNull();
    expect(toEvent({ id: 'r3', cells: { p2: 'nonsense' } }, due, title, [], null)).toBeNull();
    expect(toEvent({ id: 'r4', cells: { p2: '2026-12-01T00:00:00.000Z' } }, due, undefined, [], null)!.title).toBe('Untitled');
    expect(cellText({ id: 'x', name: 'Done', type: 'checkbox' }, true)).toBe('Yes');
    expect(cellText({ id: 'x', name: 'Rich', type: 'text' }, { type: 'doc' })).toBe('');
  });
});
