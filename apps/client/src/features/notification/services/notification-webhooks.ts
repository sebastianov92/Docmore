import api from "@/lib/api-client";

export type INotificationWebhook = { id: string; type: "slack" | "teams"; name: string; url: string; events: string[]; createdAt: string };

export async function listNotificationWebhooks(): Promise<{ items: INotificationWebhook[] }> {
  const req = await api.post("/notifications/webhooks", {});
  return req.data;
}
export async function addNotificationWebhook(data: { type: "slack" | "teams"; name?: string; url: string; events?: string[] }): Promise<INotificationWebhook> {
  const req = await api.post("/notifications/webhooks/add", data);
  return req.data;
}
export async function removeNotificationWebhook(id: string): Promise<void> {
  await api.post("/notifications/webhooks/remove", { id });
}
export async function testNotificationWebhook(id: string): Promise<{ ok: boolean }> {
  const req = await api.post("/notifications/webhooks/test", { id });
  return req.data;
}
