export const ANNOUNCEMENT_TYPES = ['info', 'success', 'warning', 'critical', 'neutral'] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_COLORS = ['blue', 'green', 'yellow', 'red', 'purple', 'gray', 'black'] as const;
export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number];

export const ANNOUNCEMENT_AUDIENCES = ['members', 'everyone'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const ANNOUNCEMENT_STATUSES = ['active', 'archived', 'all'] as const;
export type AnnouncementListStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const ANNOUNCEMENT_MAX_TITLE_LENGTH = 100;
export const ANNOUNCEMENT_MAX_TEXT_LENGTH = 500;

export type AnnouncementMark =
  | { type: 'bold' | 'italic' | 'underline' }
  | { type: 'link'; attrs: { href: string } };

export interface AnnouncementText {
  type: 'text';
  text: string;
  marks?: AnnouncementMark[];
}

// One paragraph of marked text; that is all a banner holds.
export interface AnnouncementContent {
  type: 'doc';
  content: [{ type: 'paragraph'; content: AnnouncementText[] }];
}
