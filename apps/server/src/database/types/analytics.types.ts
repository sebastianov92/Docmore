import { Generated, Timestamp } from '@docmost/db/types/db';

// Views per page, viewer and day.
export interface PageViews {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  viewerKey: string;
  day: Timestamp;
  views: Generated<number>;
  lastViewedAt: Generated<Timestamp>;
}
