import { describe, expect, it } from "vitest";
import {
  canReviewChanges,
  containsDiagram,
  defaultBaselineKind,
  isLockedStatus,
  isValidPeriod,
  periodEndsAt,
  reviewLinkTarget,
} from "./utils";

describe("page verification utils", () => {
  it("locks verified and in-flight approval states only", () => {
    expect(isLockedStatus("verified")).toBe(true);
    expect(isLockedStatus("expiring")).toBe(true);
    expect(isLockedStatus("in_approval")).toBe(true);
    expect(isLockedStatus("approved")).toBe(true);
    expect(isLockedStatus("expired")).toBe(false);
    expect(isLockedStatus("draft")).toBe(false);
    expect(isLockedStatus(undefined)).toBe(false);
  });

  it("validates periods per unit", () => {
    expect(isValidPeriod(1, "day")).toBe(true);
    expect(isValidPeriod(120, "month")).toBe(true);
    expect(isValidPeriod(121, "month")).toBe(false);
    expect(isValidPeriod(0, "year")).toBe(false);
  });

  it("adds whole days for a period", () => {
    const from = new Date(2026, 0, 1);
    expect(periodEndsAt(2, "week", from)).toEqual(new Date(2026, 0, 15));
  });

  it("offers a review only with a baseline and drift", () => {
    expect(canReviewChanges(undefined)).toBe(false);
    expect(
      canReviewChanges({ type: "expiring", status: "invalidated", verifiedHistoryId: "h" }),
    ).toBe(true);
    expect(
      canReviewChanges({ type: "expiring", status: "verified", verifiedHistoryId: "h" }),
    ).toBe(false);
    expect(
      canReviewChanges({ type: "qms", status: "draft", rejectedHistoryId: "h" }),
    ).toBe(true);
    expect(canReviewChanges({ type: "qms", status: "approved", verifiedHistoryId: "h" })).toBe(false);
  });

  it("routes a review link to the right dialog", () => {
    expect(reviewLinkTarget({ type: "expiring", status: "expired", verifiedHistoryId: "h" })).toBe("review");
    expect(reviewLinkTarget({ type: "qms", status: "approved" })).toBe("verification");
    expect(reviewLinkTarget({ status: "none" })).toBe("none");
  });

  it("picks the verified baseline before the rejected one", () => {
    expect(defaultBaselineKind({ verified: {}, rejected: {} })).toBe("verified");
    expect(defaultBaselineKind({ rejected: {} })).toBe("rejected");
    expect(defaultBaselineKind({})).toBeNull();
  });

  it("finds diagrams anywhere in the document", () => {
    expect(containsDiagram({ type: "doc", content: [{ type: "paragraph" }] })).toBe(false);
    expect(
      containsDiagram({ type: "doc", content: [{ type: "columns", content: [{ type: "drawio" }] }] }),
    ).toBe(true);
  });
});
