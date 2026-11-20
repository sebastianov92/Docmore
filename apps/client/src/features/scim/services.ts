import api from "@/lib/api-client";

export type IScimToken = { id: string; name: string; tokenLastFour: string; isEnabled: boolean; lastUsedAt: string | null; createdAt: string; token?: string };

export async function listScimTokens(): Promise<{ items: IScimToken[]; baseUrl: string; enabled: boolean }> {
  return (await api.post("/scim/tokens", {})).data;
}
export async function createScimToken(name?: string): Promise<IScimToken> {
  return (await api.post("/scim/tokens/create", { name })).data;
}
export async function revokeScimToken(id: string): Promise<void> {
  await api.post("/scim/tokens/revoke", { id });
}
