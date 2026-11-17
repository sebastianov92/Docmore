import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  archiveAnnouncement,
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncements,
  getVisibleAnnouncements,
  unarchiveAnnouncement,
  updateAnnouncement,
} from "./services";
import {
  AnnouncementConflict,
  AnnouncementListParams,
  AnnouncementSurface,
  AnnouncementTakeover,
  VisibleBanners,
} from "./types";

export const ANNOUNCEMENTS_KEY = ["announcements"];

interface ConflictBody {
  conflict?: AnnouncementConflict;
  replaces?: AnnouncementTakeover[];
  replacedBy?: AnnouncementTakeover[];
}

function body(error: unknown): ConflictBody | undefined {
  return (error as { response?: { data?: ConflictBody } } | null)?.response?.data;
}

export function getAnnouncementConflict(error: unknown): AnnouncementConflict | null {
  const conflict = body(error)?.conflict;
  return Array.isArray(conflict?.announcements) ? conflict : null;
}

export function getAnnouncementTakeovers(error: unknown): { replaces: AnnouncementTakeover[]; replacedBy: AnnouncementTakeover[] } | null {
  const data = body(error);
  if (!data || (!Array.isArray(data.replaces) && !Array.isArray(data.replacedBy))) return null;
  return { replaces: data.replaces ?? [], replacedBy: data.replacedBy ?? [] };
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY });
}

export function useAnnouncementsQuery(params: AnnouncementListParams, enabled = true) {
  return useQuery({
    queryKey: [...ANNOUNCEMENTS_KEY, "list", params],
    queryFn: () => getAnnouncements(params),
    enabled,
    placeholderData: keepPreviousData,
    refetchOnMount: "always",
  });
}

// Banners refresh every five minutes and on focus; the component itself
// handles the minute-level switching between scheduled ones.
export function useVisibleAnnouncementsQuery(surface: AnnouncementSurface, enabled = true) {
  return useQuery<VisibleBanners>({
    queryKey: [...ANNOUNCEMENTS_KEY, "visible", surface],
    queryFn: async () => {
      const { now, items } = await getVisibleAnnouncements(surface);
      return { items, offsetMs: Date.parse(now) - Date.now() };
    },
    enabled,
    staleTime: 60_000,
    refetchOnMount: true,
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export function useCreateAnnouncementMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: createAnnouncement,
    onSuccess: () => {
      notifications.show({ message: t("Announcement created") });
      invalidate();
    },
  });
}

export function useUpdateAnnouncementMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: updateAnnouncement,
    onSuccess: () => {
      notifications.show({ message: t("Announcement updated") });
      invalidate();
    },
  });
}

export function useArchiveAnnouncementMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: archiveAnnouncement,
    onSuccess: () => {
      notifications.show({ message: t("Announcement archived") });
      invalidate();
    },
    onError: (err) => notifications.show({ message: getApiErrorMessage(err, t("Could not archive the announcement")), color: "red" }),
  });
}

export function useUnarchiveAnnouncementMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: unarchiveAnnouncement,
    onSuccess: () => {
      notifications.show({ message: t("Announcement restored") });
      invalidate();
    },
    onError: (err) => {
      const conflict = getAnnouncementConflict(err);
      notifications.show({
        color: "red",
        title: conflict ? t("Only one announcement can show at a time.") : undefined,
        message: conflict
          ? t("It overlaps: {{titles}}", { titles: conflict.announcements.map((a) => a.title).join(", ") })
          : getApiErrorMessage(err, t("Could not restore the announcement")),
        autoClose: 8000,
      });
    },
  });
}

export function useDeleteAnnouncementMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: deleteAnnouncement,
    onSuccess: () => {
      notifications.show({ message: t("Announcement deleted") });
      invalidate();
    },
    onError: (err) => notifications.show({ message: getApiErrorMessage(err, t("Could not delete the announcement")), color: "red" }),
  });
}
