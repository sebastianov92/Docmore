import api from "@/lib/api-client";

export interface IMyWorkItem {
  rowId: string;
  pageId: string;
  title: string;
  pageTitle: string;
  url: string;
  status: { name: string; color: string | null } | null;
  date: string | null;
  updatedAt: string;
}

export async function getMyWork(days = 7): Promise<{ tasks: IMyWorkItem[]; upcoming: IMyWorkItem[] }> {
  return (await api.post("/bases/my-work", { days })).data;
}

export const DEFAULT_HOME_WIDGETS = ["tasks", "upcoming", "shortcuts"];
