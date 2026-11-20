import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// page_suggestions: proposed versions of a page awaiting review.
export interface PageSuggestions {
  id: Generated<string>;
  workspaceId: string;
  spaceId: string;
  pageId: string;
  authorId: string;
  title: string | null;
  note: string | null;
  baseContent: Json | null;
  content: Json;
  status: Generated<string>;
  reviewerId: string | null;
  reviewNote: string | null;
  reviewedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
