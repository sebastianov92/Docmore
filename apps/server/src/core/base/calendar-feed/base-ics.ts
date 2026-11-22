// The rows of a base as an iCalendar feed (RFC 5545). Pure: no database.

export interface IcsEvent {
  uid: string;
  title: string;
  // an instant; for a whole-day event only its day counts
  start: Date;
  allDay: boolean;
  // the day of a whole-day event, as the person who owns the feed sees it
  day?: string; // YYYYMMDD
  updatedAt?: Date;
  url?: string;
  description?: string;
}

export interface IcsCalendar {
  name: string;
  host: string;
  events: IcsEvent[];
  now?: Date;
}

const TIMED_MINUTES = 60;

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// Lines are at most 75 octets; a longer one goes on in the next line after
// a space. A character is never cut in two.
export function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    const limit = out.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// The calendar day of an instant in a time zone, as YYYYMMDD.
export function dayIn(date: Date, timeZone: string | null | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}${get('month')}${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10).replace(/-/g, '');
  }
}

// A date without a time is stored as midnight: of UTC when it was typed as
// a plain day, of the writer's zone when it was picked on a calendar.
export function wholeDay(date: Date, timeZone: string | null | undefined): string {
  const utcMidnight =
    date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return utcMidnight ? dayIn(date, 'UTC') : dayIn(date, timeZone);
}

export function nextDay(day: string): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + 1));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export function buildIcs(calendar: IcsCalendar): string {
  const now = calendar.now ?? new Date();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Docmore//Base calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `NAME:${escapeText(calendar.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const event of calendar.events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid}@${calendar.host}`);
    lines.push(`DTSTAMP:${stamp(event.updatedAt ?? now)}`);
    if (event.updatedAt) lines.push(`LAST-MODIFIED:${stamp(event.updatedAt)}`);
    if (event.allDay) {
      const day = event.day ?? dayIn(event.start, 'UTC');
      lines.push(`DTSTART;VALUE=DATE:${day}`);
      lines.push(`DTEND;VALUE=DATE:${nextDay(day)}`);
    } else {
      lines.push(`DTSTART:${stamp(event.start)}`);
      lines.push(`DTEND:${stamp(new Date(event.start.getTime() + TIMED_MINUTES * 60_000))}`);
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
