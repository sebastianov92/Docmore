import { Generated, Json, Timestamp } from '@docmost/db/types/db';

export interface BaseAutomations {
  id: Generated<string>;
  pageId: string;
  workspaceId: string;
  name: string;
  enabled: Generated<boolean>;
  trigger: Json;
  conditions: Json | null;
  actions: Generated<Json>;
  creatorId: string | null;
  runCount: Generated<number>;
  lastRunAt: Timestamp | null;
  lastError: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface BaseAutomationRuns {
  id: Generated<string>;
  automationId: string;
  rowId: string | null;
  status: string;
  error: string | null;
  createdAt: Generated<Timestamp>;
}

export interface BaseForms {
  id: Generated<string>;
  pageId: string;
  workspaceId: string;
  token: string;
  name: string;
  description: string | null;
  fields: Generated<Json>;
  submitLabel: string | null;
  thanksText: string | null;
  enabled: Generated<boolean>;
  creatorId: string | null;
  submissions: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
