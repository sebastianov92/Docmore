import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { IPage } from "@/features/page/types/page.types";
import {
  addPagePermission,
  getPagePermissions,
  getPageRestrictionInfo,
  removePagePermission,
  restrictPage,
  unrestrictPage,
  updatePagePermission,
} from "@/features/page-permission/services/page-permission-service.ts";
import {
  IAddPagePermission,
  IPageRestrictionInfo,
  IRemovePagePermission,
  IUpdatePagePermission,
} from "@/features/page-permission/types/page-permission.types.ts";

const RESTRICTION_KEY = "page-restriction";
const MEMBERS_KEY = "page-access-members";

function apiMessage(error: unknown): string | undefined {
  return (error as any)?.response?.data?.message;
}

export function usePageRestrictionQuery(
  pageId: string | undefined,
): UseQueryResult<IPageRestrictionInfo, Error> {
  return useQuery({
    queryKey: [RESTRICTION_KEY, pageId],
    queryFn: () => getPageRestrictionInfo(pageId as string),
    enabled: !!pageId,
  });
}

export function usePageAccessMembersQuery(pageId: string | undefined) {
  return useInfiniteQuery({
    queryKey: [MEMBERS_KEY, pageId],
    queryFn: ({ pageParam }) => getPagePermissions(pageId as string, pageParam),
    enabled: !!pageId,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
  });
}

// The page query carries permissions.hasRestriction, which drives the lock badge.
function useRefreshAfterRestrictionChange() {
  const queryClient = useQueryClient();
  return (pageId: string, hasRestriction: boolean) => {
    queryClient.setQueriesData<IPage>({ queryKey: ["pages"] }, (old) =>
      old?.id === pageId
        ? { ...old, permissions: { canEdit: old.permissions?.canEdit ?? true, hasRestriction } }
        : old,
    );
    queryClient.invalidateQueries({ queryKey: [RESTRICTION_KEY, pageId] });
    queryClient.removeQueries({ queryKey: [MEMBERS_KEY, pageId] });
    queryClient.invalidateQueries({ queryKey: ["sidebar-pages"] });
  };
}

export function useRestrictPageMutation() {
  const { t } = useTranslation();
  const refresh = useRefreshAfterRestrictionChange();

  return useMutation<void, Error, string>({
    mutationFn: restrictPage,
    onSuccess: (_data, pageId) => refresh(pageId, true),
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not restrict the page"),
        color: "red",
      });
    },
  });
}

export function useUnrestrictPageMutation() {
  const { t } = useTranslation();
  const refresh = useRefreshAfterRestrictionChange();

  return useMutation<void, Error, string>({
    mutationFn: unrestrictPage,
    onSuccess: (_data, pageId) => refresh(pageId, false),
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not open the page up again"),
        color: "red",
      });
    },
  });
}

function useInvalidateMembers() {
  const queryClient = useQueryClient();
  return (pageId: string) => {
    queryClient.invalidateQueries({ queryKey: [MEMBERS_KEY, pageId] });
    queryClient.invalidateQueries({ queryKey: [RESTRICTION_KEY, pageId] });
  };
}

export function useAddPagePermissionMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateMembers();

  return useMutation<void, Error, IAddPagePermission>({
    mutationFn: addPagePermission,
    onSuccess: (_data, variables) => invalidate(variables.pageId),
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not give access"),
        color: "red",
      });
    },
  });
}

export function useUpdatePagePermissionMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateMembers();

  return useMutation<void, Error, IUpdatePagePermission>({
    mutationFn: updatePagePermission,
    onSuccess: (_data, variables) => invalidate(variables.pageId),
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not change the role"),
        color: "red",
      });
    },
  });
}

export function useRemovePagePermissionMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateMembers();

  return useMutation<void, Error, IRemovePagePermission>({
    mutationFn: removePagePermission,
    onSuccess: (_data, variables) => invalidate(variables.pageId),
    onError: (error) => {
      notifications.show({
        message: apiMessage(error) || t("Could not remove access"),
        color: "red",
      });
    },
  });
}
