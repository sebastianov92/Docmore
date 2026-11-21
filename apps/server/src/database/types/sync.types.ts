import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// sync_changes: one row per entity, seq moves forward on every change.
export interface SyncChanges {
  entityType: string;
  entityId: string;
  workspaceId: string;
  seq: string;
  deleted: Generated<boolean>;
  changedAt: Generated<Timestamp>;
}

// idempotency_keys: the stored answer of a write that may be retried.
export interface IdempotencyKeys {
  userId: string;
  key: string;
  workspaceId: string;
  route: string;
  response: Json | null;
  createdAt: Generated<Timestamp>;
}

// offline_pins: what a person marked available offline on one device.
export interface OfflinePins {
  id: Generated<string>;
  workspaceId: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  entityType: string;
  entityId: string;
  createdAt: Generated<Timestamp>;
}
