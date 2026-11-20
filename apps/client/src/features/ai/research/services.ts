import api from "@/lib/api-client";

export interface IResearchSource {
  n: number;
  pageId: string;
  title: string;
  url: string;
}

export interface IResearchReport {
  id: string;
  chatId: string | null;
  question: string;
  status: "queued" | "running" | "done" | "failed";
  progress: { step: string; done: number; total: number; note?: string } | null;
  report: string | null;
  sources: IResearchSource[];
  pageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function startResearch(data: { question: string; chatId?: string; spaceId?: string }): Promise<IResearchReport> {
  return (await api.post("/ai/research/start", data)).data;
}
export async function researchStatus(reportId: string): Promise<IResearchReport> {
  return (await api.post("/ai/research/status", { reportId })).data;
}
export async function saveResearchAsPage(data: { reportId: string; spaceId: string; parentPageId?: string }): Promise<{ pageId: string; title: string; slugId: string; url: string }> {
  return (await api.post("/ai/research/save-page", data)).data;
}
