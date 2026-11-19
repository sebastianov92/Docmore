import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { AiSettingsTable, AiUsageTable } from '@docmost/db/types/ai-settings.types';
import {
  SpaceJoinRequests,
  WorkspaceInviteRequests,
} from '@docmost/db/types/requests.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  aiSettings: AiSettingsTable;
  aiUsage: AiUsageTable;
  spaceJoinRequests: SpaceJoinRequests;
  workspaceInviteRequests: WorkspaceInviteRequests;
}
