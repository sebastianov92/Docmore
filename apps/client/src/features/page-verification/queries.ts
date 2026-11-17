import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { IPagination } from "@/lib/types";
import {
  VERIFICATION_CHANGES_KEY,
  VERIFICATION_INFO_KEY,
  VERIFICATION_LIST_KEY,
} from "./constants";
import {
  getVerificationChanges,
  getVerificationInfo,
  getVerificationList,
  markObsolete,
  rejectApproval,
  removeVerification,
  setupVerification,
  submitForApproval,
  updateVerification,
  verifyPage,
} from "./services";
import {
  IPageVerificationInfo,
  IVerificationChanges,
  IVerificationListItem,
  IVerificationListParams,
} from "./types";

export function usePageVerificationInfoQuery(
  pageId: string | undefined,
): UseQueryResult<IPageVerificationInfo, Error> {
  return useQuery({
    queryKey: [VERIFICATION_INFO_KEY, pageId],
    queryFn: () => getVerificationInfo(pageId!),
    enabled: !!pageId,
    refetchOnMount: true,
  });
}

// Fetched fresh on every open: the server flushes pending edits first.
export function usePageVerificationChangesQuery(
  pageId: string | undefined,
  enabled: boolean,
): UseQueryResult<IVerificationChanges, Error> {
  return useQuery({
    queryKey: [VERIFICATION_CHANGES_KEY, pageId],
    queryFn: () => getVerificationChanges(pageId!),
    enabled: enabled && !!pageId,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useVerificationListQuery(
  params: IVerificationListParams,
): UseQueryResult<IPagination<IVerificationListItem>, Error> {
  return useQuery({
    queryKey: [VERIFICATION_LIST_KEY, params],
    queryFn: () => getVerificationList(params),
    placeholderData: keepPreviousData,
  });
}

// Every write returns the fresh info; put it in the cache right away and
// let the list page refetch on its own.
function useVerificationWrite<TVars>(
  run: (vars: TVars) => Promise<IPageVerificationInfo | void>,
  pageIdOf: (vars: TVars) => string,
  doneMessage: string,
  failMessage: string,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation<IPageVerificationInfo | void, Error, TVars>({
    mutationFn: run,
    onSuccess: (data, vars) => {
      const pageId = pageIdOf(vars);
      if (data) {
        queryClient.setQueryData([VERIFICATION_INFO_KEY, pageId], data);
      } else {
        queryClient.invalidateQueries({ queryKey: [VERIFICATION_INFO_KEY, pageId] });
      }
      queryClient.invalidateQueries({ queryKey: [VERIFICATION_LIST_KEY] });
      notifications.show({ message: t(doneMessage) });
    },
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t(failMessage)), color: "red" });
    },
  });
}

export const useSetupVerificationMutation = () =>
  useVerificationWrite(setupVerification, (v) => v.pageId, "Verification enabled", "Failed to enable verification");

export const useUpdateVerificationMutation = () =>
  useVerificationWrite(updateVerification, (v) => v.pageId, "Verification updated", "Failed to update verification");

export const useRemoveVerificationMutation = () =>
  useVerificationWrite<string>(
    async (pageId) => {
      await removeVerification(pageId);
      return { status: "none", pageId } as IPageVerificationInfo;
    },
    (pageId) => pageId,
    "Verification removed",
    "Failed to remove verification",
  );

export const useVerifyPageMutation = () =>
  useVerificationWrite<string>(verifyPage, (pageId) => pageId, "Page verified", "Failed to verify page");

export const useSubmitForApprovalMutation = () =>
  useVerificationWrite<string>(submitForApproval, (pageId) => pageId, "Submitted for approval", "Failed to submit for approval");

export const useRejectApprovalMutation = () =>
  useVerificationWrite<{ pageId: string; comment?: string }>(
    rejectApproval,
    (v) => v.pageId,
    "Returned to draft",
    "Failed to reject approval",
  );

export const useMarkObsoleteMutation = () =>
  useVerificationWrite<string>(markObsolete, (pageId) => pageId, "Page marked as obsolete", "Failed to mark as obsolete");
