import { Generated, Timestamp } from '@docmost/db/types/db';

// notion_connections: connections to Notion kept for the workspace.
export interface NotionConnections {
  id: Generated<string>;
  workspaceId: string;
  creatorId: string | null;
  name: string;
  token: string;
  account: string | null;
  lastUsedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
}
