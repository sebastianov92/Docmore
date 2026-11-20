import api from "@/lib/api-client";

export interface IMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface IMcpServer {
  id: string;
  name: string;
  url: string;
  scope: "workspace" | "personal";
  creatorId: string | null;
  hasAuth: boolean;
  authHeader: string | null;
  allowedTools: string[] | null;
  requireConfirmation: boolean;
  enabled: boolean;
  tools: IMcpTool[];
  toolsCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const MCP_SERVERS_KEY = ["ai-mcp-servers"];

export async function listMcpServers(): Promise<{ items: IMcpServer[] }> {
  return (await api.post("/ai/mcp-servers", {})).data;
}
export async function createMcpServer(data: { name: string; url: string; scope: "workspace" | "personal"; authHeader?: string; authValue?: string; requireConfirmation?: boolean }): Promise<IMcpServer> {
  return (await api.post("/ai/mcp-servers/create", data)).data;
}
export async function updateMcpServer(data: { serverId: string; name?: string; url?: string; authHeader?: string; authValue?: string; clearAuth?: boolean; allowedTools?: string[] | null; requireConfirmation?: boolean; enabled?: boolean }): Promise<IMcpServer> {
  return (await api.post("/ai/mcp-servers/update", data)).data;
}
export async function deleteMcpServer(serverId: string): Promise<void> {
  await api.post("/ai/mcp-servers/delete", { serverId });
}
export async function testMcpServer(serverId: string): Promise<IMcpServer> {
  return (await api.post("/ai/mcp-servers/test", { serverId })).data;
}
