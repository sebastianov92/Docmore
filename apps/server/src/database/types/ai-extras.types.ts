import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// ai_mcp_servers: outside MCP servers the chat may call tools on.
export interface AiMcpServers {
  id: Generated<string>;
  workspaceId: string;
  name: string;
  url: string;
  scope: string;
  creatorId: string | null;
  auth: string | null;
  allowedTools: Json | null;
  requireConfirmation: Generated<boolean>;
  enabled: Generated<boolean>;
  toolCache: Json | null;
  toolsCheckedAt: Timestamp | null;
  lastError: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}

export interface AiToolApprovals {
  id: Generated<string>;
  workspaceId: string;
  chatId: string;
  userId: string;
  serverId: string;
  toolCallId: string;
  toolName: string;
  args: Json | null;
  status: Generated<string>;
  result: Json | null;
  createdAt: Generated<Timestamp>;
  resolvedAt: Timestamp | null;
}

// ai_skills: reusable instructions for the chat and the editor.
export interface AiSkills {
  id: Generated<string>;
  workspaceId: string;
  creatorId: string | null;
  name: string;
  slug: string;
  description: string | null;
  instructions: string;
  scope: string;
  enabled: Generated<boolean>;
  useCount: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}

export interface AiResearchReports {
  id: Generated<string>;
  workspaceId: string;
  userId: string;
  chatId: string | null;
  spaceId: string | null;
  question: string;
  status: Generated<string>;
  progress: Json | null;
  report: string | null;
  sources: Json | null;
  usage: Json | null;
  error: string | null;
  pageId: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface AiMeetingNotes {
  id: Generated<string>;
  workspaceId: string;
  userId: string;
  pageId: string | null;
  spaceId: string | null;
  attachmentId: string | null;
  fileName: string | null;
  status: Generated<string>;
  language: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  segments: Json | null;
  summary: string | null;
  error: string | null;
  mode: string | null;
  speakers: Generated<Json>;
  items: Generated<Json>;
  itemsRevision: Generated<number>;
  liveCursor: Generated<number>;
  notes: Json | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}
