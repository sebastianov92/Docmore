import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// notion_imports: imports from Notion through its API.
export interface NotionImports {
  id: Generated<string>;
  workspaceId: string;
  creatorId: string;
  spaceId: string;
  parentPageId: string | null;
  status: Generated<string>;
  progress: Json | null;
  report: Json | null;
  error: string | null;
  createdAt: Generated<Timestamp>;
  finishedAt: Timestamp | null;
}
