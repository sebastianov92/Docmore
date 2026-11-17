import { useEffect, useRef } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { currentPageEditModeAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { usePageVerificationInfoQuery } from "@/features/page-verification/queries";
import { unlockedVerifiedPageIdAtom } from "@/features/page-verification/atoms";
import { isLockedStatus } from "@/features/page-verification/utils";
import { VerificationStatus } from "@/features/page-verification/types";

function useVerificationStatus(pageId: string | undefined): VerificationStatus | undefined {
  const { data } = usePageVerificationInfoQuery(pageId);
  return data?.status;
}

function confirmationFor(status: VerificationStatus | undefined, t: (k: string) => string) {
  if (status === "approved") {
    return {
      title: t("Edit an approved page?"),
      message: t("Any change returns this page to draft; it will need approval again."),
    };
  }
  if (status === "in_approval") {
    return {
      title: t("Edit a page in approval?"),
      message: t("Any change withdraws the approval request and returns the page to draft."),
    };
  }
  return {
    title: t("Edit a verified page?"),
    message: t("Any change marks the page as changed until a verifier confirms it again."),
  };
}

// A verified or approved page opens read-only. Switching to edit asks once
// and remembers the answer for that page until its status changes.
export function usePageEditMode(pageId?: string) {
  const { t } = useTranslation();
  const status = useVerificationStatus(pageId);
  const isLocked = isLockedStatus(status);
  const [sessionMode, setSessionMode] = useAtom(currentPageEditModeAtom);
  const [unlockedPageId, setUnlockedPageId] = useAtom(unlockedVerifiedPageIdAtom);

  const editMode =
    pageId && unlockedPageId === pageId
      ? PageEditMode.Edit
      : isLocked
        ? PageEditMode.Read
        : sessionMode;

  const changeEditMode = (mode: PageEditMode) => {
    if (!isLocked) {
      setSessionMode(mode);
      setUnlockedPageId(null);
      return;
    }
    if (mode === PageEditMode.Read) {
      setUnlockedPageId(null);
      return;
    }
    const { title, message } = confirmationFor(status, t);
    modals.openConfirmModal({
      title,
      centered: true,
      children: <Text size="sm">{message}</Text>,
      labels: { confirm: t("Edit anyway"), cancel: t("Cancel") },
      onConfirm: () => setUnlockedPageId(pageId ?? null),
    });
  };

  return { editMode, isLocked, changeEditMode };
}

// Drops the unlock when the page changes or when it becomes locked again
// (for example right after the user verifies it).
export function usePageEditLockSync(pageId: string): void {
  const status = useVerificationStatus(pageId);
  const setUnlockedPageId = useSetAtom(unlockedVerifiedPageIdAtom);
  const previous = useRef(status);

  useEffect(() => {
    return () => {
      setUnlockedPageId(null);
    };
  }, [pageId, setUnlockedPageId]);

  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (before && before !== status && isLockedStatus(status)) {
      setUnlockedPageId(null);
    }
  }, [status, setUnlockedPageId]);
}
