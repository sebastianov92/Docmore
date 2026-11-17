import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useSetAtom } from "jotai";
import type { QueryObserverResult } from "@tanstack/react-query";
import { reviewChangesAtom } from "@/features/page-verification/atoms";
import { reviewLinkTarget } from "@/features/page-verification/utils";
import { IPageVerificationInfo } from "@/features/page-verification/types";

const PARAM = "review";
const VALUE = "changes";

// Notification emails link to ?review=changes. Open the review dialog when
// there is something to compare, else the verification dialog.
export function useReviewDeepLink(opts: {
  pageId: string | undefined;
  refetchInfo: () => Promise<QueryObserverResult<IPageVerificationInfo, Error>>;
  onOpenVerification: () => void;
}) {
  const { pageId, refetchInfo, onOpenVerification } = opts;
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(PARAM) === VALUE;
  const setReview = useSetAtom(reviewChangesAtom);
  const handled = useRef<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!requested) {
      handled.current = null;
      return;
    }
    if (!pageId || handled.current === pageId) return;
    handled.current = pageId;

    const next = new URLSearchParams(searchParams);
    next.delete(PARAM);
    setSearchParams(next, { replace: true });

    void refetchInfo().then(({ data, isError }) => {
      if (!mounted.current || isError) return;
      const target = reviewLinkTarget(data);
      if (target === "review") setReview({ pageId, source: "link" });
      else if (target === "verification") onOpenVerification();
    });
  }, [requested, pageId, searchParams, setSearchParams, refetchInfo, setReview, onOpenVerification]);
}
