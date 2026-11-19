import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// space_join_requests: a member asking to join a closed space.
export interface SpaceJoinRequests {
  id: Generated<string>;
  spaceId: string;
  userId: string;
  workspaceId: string;
  note: string | null;
  status: Generated<string>;
  reviewedById: string | null;
  reviewedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

// workspace_invite_requests: a member asking admins to invite someone.
export interface WorkspaceInviteRequests {
  id: Generated<string>;
  workspaceId: string;
  requesterId: string;
  email: string;
  note: string | null;
  status: Generated<string>;
  reviewedById: string | null;
  reviewedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
