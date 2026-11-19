import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// ai_settings: one row per workspace with provider credentials (encrypted)
// and the chosen models. Created by the 20261117T120000-ai-settings migration.
export interface AiSettingsTable {
  workspaceId: string;
  providers: Generated<Json>;
  generation: Json | null;
  embedding: Json | null;
  limits: Json | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

// ai_usage: requests per user per day, for the per-person limit.
export interface AiUsageTable {
  workspaceId: string;
  userId: string;
  day: Timestamp;
  requests: Generated<number>;
  updatedAt: Generated<Timestamp>;
}
