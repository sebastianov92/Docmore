import api from "@/lib/api-client";
import { IPagination } from "@/lib/types";
import {
  Announcement,
  AnnouncementBanner,
  AnnouncementInput,
  AnnouncementListParams,
} from "./types";

export async function getAnnouncements(params: AnnouncementListParams): Promise<IPagination<Announcement>> {
  const req = await api.post<IPagination<Announcement>>("/announcements", params);
  return req.data;
}

export async function getVisibleAnnouncements(surface: "app" | "public"): Promise<{ now: string; items: AnnouncementBanner[] }> {
  const req = await api.post(surface === "app" ? "/announcements/visible" : "/announcements/public", {});
  return req.data;
}

export async function createAnnouncement(data: AnnouncementInput): Promise<Announcement> {
  const req = await api.post<Announcement>("/announcements/create", data);
  return req.data;
}

export async function updateAnnouncement(data: AnnouncementInput & { announcementId: string }): Promise<Announcement> {
  const req = await api.post<Announcement>("/announcements/update", data);
  return req.data;
}

export async function archiveAnnouncement(announcementId: string): Promise<Announcement> {
  const req = await api.post<Announcement>("/announcements/archive", { announcementId });
  return req.data;
}

export async function unarchiveAnnouncement(announcementId: string): Promise<Announcement> {
  const req = await api.post<Announcement>("/announcements/unarchive", { announcementId });
  return req.data;
}

export async function deleteAnnouncement(announcementId: string): Promise<void> {
  await api.post("/announcements/delete", { announcementId });
}
