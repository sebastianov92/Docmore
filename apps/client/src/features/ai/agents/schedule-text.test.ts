import { describe, expect, it } from "vitest";
import { clock, outputText, relativeTime, scheduleText, weekdayName } from "./schedule-text";

const t = (key: string, values: Record<string, unknown> = {}) => key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name]));

describe("agent schedule in words", () => {
  it("writes the time and the days", () => {
    expect(clock(8, 5)).toBe("08:05");
    expect(weekdayName(0, "en-US")).toBe("Sunday");
    expect(weekdayName(1, "es-ES")).toBe("lunes");
    expect(scheduleText({ kind: "daily", hour: 8, minute: 0, timezone: "UTC" }, t, "en-US", "UTC")).toBe("Every day at 08:00");
    expect(scheduleText({ kind: "weekly", hour: 9, minute: 30, weekdays: [4, 1], timezone: "UTC" }, t, "en-US", "UTC")).toBe(
      "Every Monday and Thursday at 09:30",
    );
    expect(scheduleText({ kind: "weekly", hour: 9, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" }, t, "en-US", "UTC")).toBe("Every day at 09:00");
    expect(scheduleText({ kind: "monthly", hour: 7, minute: 0, dayOfMonth: 15, timezone: "UTC" }, t, "en-US", "UTC")).toBe(
      "On day 15 of every month at 07:00",
    );
  });

  it("names the zone when it is not the reader's", () => {
    expect(scheduleText({ kind: "daily", hour: 8, minute: 0, timezone: "Europe/Madrid" }, t, "en-US", "America/Guayaquil")).toBe(
      "Every day at 08:00 (Europe/Madrid)",
    );
  });

  it("says where the result goes", () => {
    expect(outputText({ output: { kind: "notify" }, outputPage: null, outputSpace: null }, t)).toBe("A notification");
    expect(outputText({ output: { kind: "page", spaceId: "s" }, outputPage: null, outputSpace: { id: "s", name: "General", slug: "general" } }, t)).toBe("A new page in General");
    expect(outputText({ output: { kind: "page", spaceId: "s", parentPageId: "p" }, outputPage: { id: "p", title: "Digests", url: "/x" }, outputSpace: null }, t)).toBe(
      "A new page under “Digests”",
    );
    expect(outputText({ output: { kind: "append", pageId: "p" }, outputPage: { id: "p", title: "Log", url: "/x" }, outputSpace: null }, t)).toBe("Added to “Log”");
  });

  it("tells how far a time is", () => {
    const now = Date.UTC(2026, 10, 22, 12);
    expect(relativeTime(new Date(now + 3 * 3_600_000).toISOString(), "en-US", now)).toBe("in 3 hours");
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), "en-US", now)).toBe("2 days ago");
    expect(relativeTime(null, "en-US", now)).toBe("");
  });
});
