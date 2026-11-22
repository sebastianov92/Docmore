import { BadRequestException } from '@nestjs/common';

// When a scheduled agent runs: every day, on some days of the week, or on
// one day of the month, at an hour of the clock in a time zone. Pure.
export interface AgentSchedule {
  kind: 'daily' | 'weekly' | 'monthly';
  hour: number;
  minute: number;
  // weekly: 0 = Sunday … 6 = Saturday
  weekdays?: number[];
  // monthly: 1–28, so every month has the day
  dayOfMonth?: number;
  // IANA name, for example America/Guayaquil
  timezone: string;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// What a person sent, checked and tidied; throws on nonsense.
export function readSchedule(raw: unknown): AgentSchedule {
  const input = (raw ?? {}) as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'monthly') {
    throw new BadRequestException('The schedule is daily, weekly or monthly');
  }
  const hour = Number(input.hour);
  const minute = Number(input.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new BadRequestException('The hour goes from 0 to 23');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new BadRequestException('The minute goes from 0 to 59');
  if (!isTimeZone(input.timezone)) throw new BadRequestException('Unknown time zone');
  const schedule: AgentSchedule = { kind, hour, minute, timezone: input.timezone };
  if (kind === 'weekly') {
    const days = Array.isArray(input.weekdays)
      ? [...new Set(input.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
      : [];
    if (!days.length) throw new BadRequestException('Pick at least one day of the week');
    schedule.weekdays = days;
  }
  if (kind === 'monthly') {
    const day = Number(input.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) throw new BadRequestException('The day of the month goes from 1 to 28');
    schedule.dayOfMonth = day;
  }
  return schedule;
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The clock and calendar of an instant in a time zone.
export function partsIn(date: Date, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

// The instant at which a zone's clock reads that day and time. Where the
// clock skips an hour (summer time starts) the next valid minute is used.
export function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

// The first run strictly after `after`.
export function nextRun(schedule: AgentSchedule, after: Date): Date {
  const start = partsIn(after, schedule.timezone);
  // walk the zone's calendar day by day from today
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const weekday = day.getUTCDay();
    if (schedule.kind === 'weekly' && !(schedule.weekdays ?? []).includes(weekday)) continue;
    if (schedule.kind === 'monthly' && d !== schedule.dayOfMonth) continue;
    const at = instantOf(y, m, d, schedule.hour, schedule.minute, schedule.timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  // unreachable with a checked schedule
  return new Date(after.getTime() + 86_400_000);
}

// The day as the zone writes it, for titles: 2026-11-22.
export function dayLabel(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
