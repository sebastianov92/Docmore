import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// A row's cells as they were before an edit, a delete or a conversion.
export interface BaseRowVersions {
  id: Generated<string>;
  rowId: string;
  pageId: string;
  workspaceId: string;
  cells: Json;
  kind: string;
  actorId: string | null;
  createdAt: Generated<Timestamp>;
}
