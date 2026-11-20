import api from "@/lib/api-client";

export type ViewsByDay = { day: string; views: number; viewers: number };
export type PageAnalytics = {
  days: number;
  views: number;
  uniqueViewers: number;
  lastViewedAt: string | null;
  allTimeViews: number;
  byDay: ViewsByDay[];
  viewers: { userId: string; name: string | null; avatarUrl: string | null; views: number; last: string }[];
  settings: { enabled: boolean; anonymous: boolean };
};
export type WorkspaceAnalytics = {
  days: number;
  views: number;
  activeViewers: number;
  pagesViewed: number;
  byDay: ViewsByDay[];
  topPages: { pageId: string; title: string | null; slugId: string; spaceSlug: string; spaceName: string | null; views: number; viewers: number }[];
  stalePages: { pageId: string; title: string | null; slugId: string; spaceSlug: string; spaceName: string | null; updatedAt: string; lastViewedAt: string | null }[];
  settings: { enabled: boolean; anonymous: boolean };
};

export async function trackPageView(pageId: string): Promise<void> {
  await api.post("/analytics/track", { pageId });
}
export async function getPageAnalytics(pageId: string, days = 30): Promise<PageAnalytics> {
  const req = await api.post("/analytics/page", { pageId, days });
  return req.data;
}
export async function getWorkspaceAnalytics(days = 30, spaceId?: string): Promise<WorkspaceAnalytics> {
  const req = await api.post("/analytics/workspace", { days, ...(spaceId ? { spaceId } : {}) });
  return req.data;
}
