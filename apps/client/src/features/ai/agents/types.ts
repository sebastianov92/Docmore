export type AgentScheduleKind = "daily" | "weekly" | "monthly";

export interface AgentSchedule {
  kind: AgentScheduleKind;
  hour: number;
  minute: number;
  // weekly: 0 = Sunday … 6 = Saturday
  weekdays?: number[];
  // monthly: 1–28
  dayOfMonth?: number;
  timezone: string;
}

export type AgentOutputKind = "page" | "append" | "notify";

export interface AgentOutput {
  kind: AgentOutputKind;
  spaceId?: string | null;
  parentPageId?: string | null;
  pageId?: string | null;
}

export interface AgentPageBrief {
  id: string;
  title: string;
  url: string;
}

export interface AgentSpaceBrief {
  id: string;
  name: string;
  slug: string;
}

export interface Agent {
  id: string;
  name: string;
  instructions: string;
  spaceId: string | null;
  space: AgentSpaceBrief | null;
  schedule: AgentSchedule;
  output: AgentOutput;
  outputPage: AgentPageBrief | null;
  outputSpace: AgentSpaceBrief | null;
  allowEdits: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "done" | "failed" | null;
  lastError: string | null;
  creator: { id: string; name: string; avatarUrl: string | null } | null;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: "queued" | "running" | "done" | "failed";
  trigger: "schedule" | "manual";
  result: string | null;
  error: string | null;
  page: AgentPageBrief | null;
  suggestions: Array<{ suggestionId: string; title: string; reviewUrl: string }>;
  created: AgentPageBrief[];
  steps: Array<{ name: string; detail: string }>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AgentInput {
  name?: string;
  instructions?: string;
  spaceId?: string | null;
  schedule?: AgentSchedule;
  output?: AgentOutput;
  allowEdits?: boolean;
  enabled?: boolean;
}
