import { PeriodUnit, VerificationStatus } from "./types";

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

// Pages in these states open read-only; editing asks first.
export const LOCKED_STATUSES: VerificationStatus[] = [
  "verified",
  "expiring",
  "approved",
  "in_approval",
];

// Node types whose drawing lives in an attachment both versions share, so
// a diff cannot show what changed inside them.
export const DIAGRAM_NODE_TYPES = new Set(["drawio", "excalidraw"]);

export const VERIFICATION_INFO_KEY = "page-verification-info";
export const VERIFICATION_CHANGES_KEY = "page-verification-changes";
export const VERIFICATION_LIST_KEY = "verification-list";
