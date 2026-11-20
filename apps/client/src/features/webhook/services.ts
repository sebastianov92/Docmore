import api from "@/lib/api-client";

export type IWebhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  failures: number;
  lastDeliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  secret?: string;
};
export type IWebhookDelivery = { id: string; event: string; status: number | null; ok: boolean; error: string | null; durationMs: number | null; attempt: number; createdAt: string };

export async function listWebhooks(): Promise<{ items: IWebhook[]; events: string[] }> {
  return (await api.post("/webhooks", {})).data;
}
export async function createWebhook(data: { name: string; url: string; events?: string[] }): Promise<IWebhook> {
  return (await api.post("/webhooks/create", data)).data;
}
export async function updateWebhook(data: { webhookId: string; name?: string; url?: string; events?: string[]; enabled?: boolean; rotateSecret?: boolean }): Promise<IWebhook> {
  return (await api.post("/webhooks/update", data)).data;
}
export async function deleteWebhook(webhookId: string): Promise<void> {
  await api.post("/webhooks/delete", { webhookId });
}
export async function listWebhookDeliveries(webhookId: string): Promise<{ items: IWebhookDelivery[] }> {
  return (await api.post("/webhooks/deliveries", { webhookId })).data;
}
export async function testWebhook(webhookId: string): Promise<{ queued: boolean }> {
  return (await api.post("/webhooks/test", { webhookId })).data;
}
