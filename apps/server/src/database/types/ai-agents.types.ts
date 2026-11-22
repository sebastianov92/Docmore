import { Generated, Json, Timestamp } from '@docmost/db/types/db';

// ai_agents: tasks the model carries out on a schedule for a person.
export interface AiAgents {
  id: Generated<string>;
  workspaceId: string;
  creatorId: string;
  name: string;
  instructions: string;
  spaceId: string | null;
  schedule: Json;
  output: Json;
  allowEdits: Generated<boolean>;
  enabled: Generated<boolean>;
  nextRunAt: Timestamp | null;
  lastRunAt: Timestamp | null;
  lastStatus: string | null;
  lastError: string | null;
  failures: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

// ai_agent_runs: what each run did.
export interface AiAgentRuns {
  id: Generated<string>;
  agentId: string;
  workspaceId: string;
  status: Generated<string>;
  trigger: Generated<string>;
  result: string | null;
  error: string | null;
  pageId: string | null;
  details: Json | null;
  usage: Json | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
}
