import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { AiSettingsTable, AiUsageTable } from '@docmost/db/types/ai-settings.types';
import {
  SpaceJoinRequests,
  WorkspaceInviteRequests,
} from '@docmost/db/types/requests.types';
import { BaseRowVersions } from '@docmost/db/types/base-history.types';
import { BaseAutomationRuns, BaseAutomations, BaseForms } from '@docmost/db/types/automation.types';
import { PageViews } from '@docmost/db/types/analytics.types';
import { WebhookDeliveries, Webhooks } from '@docmost/db/types/webhook.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  aiSettings: AiSettingsTable;
  aiUsage: AiUsageTable;
  spaceJoinRequests: SpaceJoinRequests;
  workspaceInviteRequests: WorkspaceInviteRequests;
  baseRowVersions: BaseRowVersions;
  baseAutomations: BaseAutomations;
  baseAutomationRuns: BaseAutomationRuns;
  baseForms: BaseForms;
  pageViews: PageViews;
  webhooks: Webhooks;
  webhookDeliveries: WebhookDeliveries;
}
