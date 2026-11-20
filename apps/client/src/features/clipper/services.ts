import api from "@/lib/api-client";

export type ClipResult = { id: string; slugId: string; title: string; spaceId: string; spaceSlug: string };

export async function clipPage(data: { spaceId: string; url: string; title?: string; html?: string; parentPageId?: string }): Promise<ClipResult> {
  const req = await api.post<ClipResult>("/clipper/clip", data);
  return req.data;
}

// The bookmarklet opens /clip with the current address and title.
export function bookmarkletCode(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `javascript:(function(){window.open('${base}/clip?u='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(document.title),'_blank');})();`;
}
