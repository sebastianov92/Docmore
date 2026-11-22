import { Generated, Timestamp } from '@docmost/db/types/db';

// base_calendar_feeds: the private .ics link of one person for one view.
export interface BaseCalendarFeeds {
  id: Generated<string>;
  workspaceId: string;
  pageId: string;
  viewId: string;
  userId: string;
  token: string;
  createdAt: Generated<Timestamp>;
  lastReadAt: Timestamp | null;
}
