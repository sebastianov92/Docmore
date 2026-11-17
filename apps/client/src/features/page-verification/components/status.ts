import { VerificationStatus } from "@/features/page-verification/types";

const COLORS: Record<VerificationStatus, string> = {
  verified: "teal",
  approved: "teal",
  expiring: "yellow",
  invalidated: "orange",
  in_approval: "blue",
  expired: "red",
  obsolete: "gray",
  draft: "gray",
  none: "gray",
};

export function statusColor(status: VerificationStatus): string {
  return COLORS[status] ?? "gray";
}

export function statusCssColor(status: VerificationStatus): string {
  const shade = statusColor(status) === "yellow" ? 8 : 7;
  return `var(--mantine-color-${statusColor(status)}-${shade})`;
}

export function statusLabel(status: VerificationStatus, t: (k: string) => string): string {
  switch (status) {
    case "verified":
      return t("Verified");
    case "expiring":
      return t("Review due");
    case "expired":
      return t("Verification expired");
    case "invalidated":
      return t("Changed since verified");
    case "draft":
      return t("Draft");
    case "in_approval":
      return t("In approval");
    case "approved":
      return t("Approved");
    case "obsolete":
      return t("Obsolete");
    default:
      return "";
  }
}
