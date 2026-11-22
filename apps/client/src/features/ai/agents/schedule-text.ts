import { Agent, AgentOutput, AgentSchedule } from "./types";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Sunday = 0, as the schedule stores it. 2024-01-07 was a Sunday.
export function weekdayName(day: number, locale: string, style: "long" | "short" = "long"): string {
  return new Date(Date.UTC(2024, 0, 7 + day, 12)).toLocaleDateString(locale, { weekday: style, timeZone: "UTC" });
}

// Monday first, the way the week is shown.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function listOf(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// "Every Monday and Thursday at 08:00", with the zone when it is not the reader's.
export function scheduleText(schedule: AgentSchedule, t: Translate, locale: string, here = browserTimeZone()): string {
  const time = clock(schedule.hour, schedule.minute);
  let text: string;
  if (schedule.kind === "weekly") {
    const days = WEEK_ORDER.filter((d) => (schedule.weekdays ?? []).includes(d)).map((d) => weekdayName(d, locale));
    text = days.length === 7 ? t("Every day at {{time}}", { time }) : t("Every {{days}} at {{time}}", { days: listOf(days, locale), time });
  } else if (schedule.kind === "monthly") {
    text = t("On day {{day}} of every month at {{time}}", { day: schedule.dayOfMonth ?? 1, time });
  } else {
    text = t("Every day at {{time}}", { time });
  }
  return schedule.timezone && schedule.timezone !== here ? `${text} (${schedule.timezone})` : text;
}

export function outputText(agent: Pick<Agent, "output" | "outputPage" | "outputSpace">, t: Translate): string {
  const output: AgentOutput = agent.output;
  if (output.kind === "page") {
    if (agent.outputPage) return t("A new page under “{{title}}”", { title: agent.outputPage.title });
    return agent.outputSpace ? t("A new page in {{space}}", { space: agent.outputSpace.name }) : t("A new page each time");
  }
  if (output.kind === "append") {
    return agent.outputPage ? t("Added to “{{title}}”", { title: agent.outputPage.title }) : t("Added to a page");
  }
  return t("A notification");
}

// "in 3 hours", "2 days ago".
export function relativeTime(iso: string | null, locale: string, now = Date.now()): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  try {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, size] of units) {
      if (abs >= size) return format.format(Math.round(diff / size), unit);
    }
    return format.format(0, "minute");
  } catch {
    return new Date(iso).toLocaleString(locale);
  }
}
