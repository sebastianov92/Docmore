import { Generated, Json, Timestamp } from '@docmost/db/types/db';

export interface Webhooks {
  id: Generated<string>;
  workspaceId: string;
  name: string;
  url: string;
  // encrypted
  secret: string;
  events: Generated<Json>;
  enabled: Generated<boolean>;
  failures: Generated<number>;
  lastDeliveredAt: Timestamp | null;
  lastError: string | null;
  creatorId: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface WebhookDeliveries {
  id: Generated<string>;
  webhookId: string;
  event: string;
  status: number | null;
  ok: Generated<boolean>;
  error: string | null;
  durationMs: number | null;
  attempt: Generated<number>;
  createdAt: Generated<Timestamp>;
}
