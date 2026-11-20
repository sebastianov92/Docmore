// Domain events a webhook may subscribe to ('*' means all of them).
export const WEBHOOK_EVENTS = [
  'page.created',
  'page.updated',
  'page.deleted',
  'page.soft_deleted',
  'page.restored',
  'space.created',
  'space.updated',
  'space.deleted',
  'base.created',
  'base.deleted',
  'base.row.created',
  'base.row.updated',
  'base.row.deleted',
  'base.rows.deleted',
  'notification.created',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const MAX_WEBHOOK_PAYLOAD_BYTES = 100_000;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
