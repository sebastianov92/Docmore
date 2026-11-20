import api from "@/lib/api-client";

export type ISiemDestination = {
  id: string;
  name: string;
  type: "webhook" | "splunk" | "elastic";
  config: { url?: string; index?: string };
  enabled: boolean;
  status: string;
  consecutiveFailures: number;
  lastDeliveredAt: string | null;
  lastError: string | null;
  hasToken: boolean;
  createdAt: string;
};

export async function listSiemDestinations(): Promise<{ items: ISiemDestination[]; types: string[] }> {
  return (await api.post("/siem/destinations", {})).data;
}
export async function createSiemDestination(data: { type: string; name: string; config: Record<string, unknown>; secrets?: Record<string, unknown> }): Promise<ISiemDestination> {
  return (await api.post("/siem/destinations/create", data)).data;
}
export async function updateSiemDestination(data: { destinationId: string; name?: string; config?: Record<string, unknown>; secrets?: Record<string, unknown>; enabled?: boolean }): Promise<ISiemDestination> {
  return (await api.post("/siem/destinations/update", data)).data;
}
export async function deleteSiemDestination(destinationId: string): Promise<void> {
  await api.post("/siem/destinations/delete", { destinationId });
}
export async function testSiemDestination(destinationId: string): Promise<{ ok: boolean }> {
  return (await api.post("/siem/destinations/test", { destinationId })).data;
}
export async function runSiemDestination(destinationId: string): Promise<{ sent: number }> {
  return (await api.post("/siem/destinations/run", { destinationId })).data;
}
