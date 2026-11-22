import api from "@/lib/api-client";
import { Agent, AgentInput, AgentRun } from "./types";

export const AGENTS_KEY = ["ai-agents"];
export const AGENT_RUNS_KEY = (agentId: string) => ["ai-agent-runs", agentId];

export async function listAgents(): Promise<{ items: Agent[] }> {
  return (await api.post("/ai/agents")).data;
}
export async function createAgent(data: AgentInput): Promise<Agent> {
  return (await api.post("/ai/agents/create", data)).data;
}
export async function updateAgent(agentId: string, data: AgentInput): Promise<Agent> {
  return (await api.post("/ai/agents/update", { agentId, ...data })).data;
}
export async function deleteAgent(agentId: string): Promise<void> {
  await api.post("/ai/agents/delete", { agentId });
}
export async function runAgent(agentId: string): Promise<AgentRun> {
  return (await api.post("/ai/agents/run", { agentId })).data;
}
export async function listAgentRuns(agentId: string): Promise<{ items: AgentRun[] }> {
  return (await api.post("/ai/agents/runs", { agentId, limit: 30 })).data;
}
