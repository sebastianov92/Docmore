export interface IAuditActor {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export interface IAuditResource {
  id: string;
  name: string;
  slug?: string;
  slugId?: string;
  spaceSlug?: string;
}

export interface IAuditLog {
  id: string;
  workspaceId: string;
  actorId?: string | null;
  actorType: "user" | "system" | "api_key" | string;
  event: string;
  resourceType: string;
  resourceId?: string | null;
  spaceId?: string | null;
  changes?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  actor?: IAuditActor | null;
  resource?: IAuditResource | null;
}

export interface IAuditLogParams {
  event?: string;
  resourceType?: string;
  actorId?: string;
  spaceId?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
}
