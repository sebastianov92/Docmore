import type { JSONContent } from "@tiptap/react";
import {
  DIAGRAM_NODE_TYPES,
  LOCKED_STATUSES,
  PERIOD_AMOUNT_MIN,
  PERIOD_UNIT_DAYS,
  PERIOD_UNIT_MAX_AMOUNT,
} from "./constants";
import {
  BaselineKind,
  IPageVerificationInfo,
  PeriodUnit,
  VerificationStatus,
} from "./types";

export function isLockedStatus(status: VerificationStatus | undefined): boolean {
  return !!status && LOCKED_STATUSES.includes(status);
}

export function isValidPeriod(amount: number, unit: PeriodUnit): boolean {
  return (
    Number.isInteger(amount) &&
    amount >= PERIOD_AMOUNT_MIN &&
    amount <= PERIOD_UNIT_MAX_AMOUNT[unit]
  );
}

export function addDays(days: number, from: Date = new Date()): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

export function periodEndsAt(amount: number, unit: PeriodUnit, from: Date = new Date()): Date {
  return addDays(amount * PERIOD_UNIT_DAYS[unit], from);
}

// A review makes sense once there is a recorded version to compare with
// and the page has drifted from it.
export function canReviewChanges(info?: IPageVerificationInfo | null): boolean {
  if (!info) return false;
  if (info.type === "expiring") {
    return (
      !!info.verifiedHistoryId &&
      (info.status === "invalidated" || info.status === "expired")
    );
  }
  if (info.type === "qms") {
    return (
      (!!info.verifiedHistoryId || !!info.rejectedHistoryId) &&
      (info.status === "draft" || info.status === "in_approval")
    );
  }
  return false;
}

export type ReviewLinkTarget = "review" | "verification" | "none";

export function reviewLinkTarget(info?: IPageVerificationInfo | null): ReviewLinkTarget {
  if (canReviewChanges(info)) return "review";
  if (info && info.status !== "none") return "verification";
  return "none";
}

export function defaultBaselineKind(baselines?: {
  verified?: unknown;
  rejected?: unknown;
}): BaselineKind | null {
  if (baselines?.verified) return "verified";
  if (baselines?.rejected) return "rejected";
  return null;
}

export function containsDiagram(doc: JSONContent | null | undefined): boolean {
  if (!doc) return false;
  if (doc.type && DIAGRAM_NODE_TYPES.has(doc.type)) return true;
  return (doc.content ?? []).some(containsDiagram);
}

export function pluralUnit(unit: PeriodUnit, amount: number, t: (k: string) => string): string {
  const one: Record<PeriodUnit, string> = { day: "day", week: "week", month: "month", year: "year" };
  const many: Record<PeriodUnit, string> = { day: "days", week: "weeks", month: "months", year: "years" };
  return t(amount === 1 ? one[unit] : many[unit]);
}
