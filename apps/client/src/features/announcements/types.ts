export const ANNOUNCEMENT_TYPES = ["info", "success", "warning", "critical", "neutral"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_COLORS = ["blue", "green", "yellow", "red", "purple", "gray", "black"] as const;
export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number];

export const ANNOUNCEMENT_AUDIENCES = ["members", "everyone"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export type AnnouncementStatus = "scheduled" | "active" | "ended" | "archived";
export type AnnouncementListStatus = "active" | "archived" | "all";
export type AnnouncementSurface = "app" | "public";

export type AnnouncementMark = { type: "bold" | "italic" | "underline" } | { type: "link"; attrs: { href: string } };

export interface AnnouncementText {
  type: "text";
  text: string;
  marks?: AnnouncementMark[];
}

export interface AnnouncementContent {
  type: "doc";
  content: [{ type: "paragraph"; content?: AnnouncementText[] }];
}

export interface AnnouncementBanner {
  id: string;
  type: AnnouncementType;
  color: AnnouncementColor;
  content: AnnouncementContent;
  isDismissible: boolean;
  startsAt: string;
  endsAt: string | null;
}

export interface Announcement extends AnnouncementBanner {
  title: string;
  audience: AnnouncementAudience;
  archivedAt: string | null;
  status: AnnouncementStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementInput {
  title: string;
  type: AnnouncementType;
  color: AnnouncementColor;
  content: AnnouncementContent;
  isDismissible: boolean;
  audience: AnnouncementAudience;
  startsAt: string | null;
  endsAt: string | null;
  replace?: boolean;
}

export interface AnnouncementListParams {
  cursor?: string;
  limit?: number;
  query?: string;
  status?: AnnouncementListStatus;
}

// Server clock minus the browser clock at the time of the response, so
// start and end times are judged on the server's time.
export interface VisibleBanners {
  items: AnnouncementBanner[];
  offsetMs: number;
}

export interface AnnouncementConflict {
  from: string;
  to: string | null;
  announcements: { id: string; title: string }[];
}

export interface AnnouncementTakeover {
  id: string;
  title: string;
  at: string;
}

export const ANNOUNCEMENT_MAX_TITLE_LENGTH = 100;
export const ANNOUNCEMENT_MAX_TEXT_LENGTH = 500;
export const ANNOUNCEMENT_PREVIEW_LENGTH = 80;
export const ANNOUNCEMENT_BANNERS_HEIGHT_VAR = "--announcement-banners-height";

export const ANNOUNCEMENT_TYPE_LABELS: Record<AnnouncementType, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
  neutral: "Neutral",
};

export const ANNOUNCEMENT_TYPE_DEFAULT_COLOR: Record<AnnouncementType, AnnouncementColor> = {
  info: "blue",
  success: "green",
  warning: "yellow",
  critical: "red",
  neutral: "gray",
};

export const ANNOUNCEMENT_COLOR_STYLES: Record<AnnouncementColor, { background: string; text: string; label: string }> = {
  blue: { background: "#1971c2", text: "#ffffff", label: "Blue" },
  green: { background: "#2a7d3d", text: "#ffffff", label: "Green" },
  yellow: { background: "#fcc419", text: "#1a1b1e", label: "Yellow" },
  red: { background: "#c92a2a", text: "#ffffff", label: "Red" },
  purple: { background: "#6e5dc6", text: "#ffffff", label: "Purple" },
  gray: { background: "#dee2e6", text: "#1a1b1e", label: "Gray" },
  black: { background: "#111111", text: "#ffffff", label: "Black" },
};
