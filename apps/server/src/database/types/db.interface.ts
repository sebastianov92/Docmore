import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { AiSettingsTable } from '@docmost/db/types/ai-settings.types';
import {
  SpaceJoinRequests,
  WorkspaceInviteRequests,
} from '@docmost/db/types/requests.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  aiSettings: AiSettingsTable;
  spaceJoinRequests: SpaceJoinRequests;
  workspaceInviteRequests: WorkspaceInviteRequests;
}
