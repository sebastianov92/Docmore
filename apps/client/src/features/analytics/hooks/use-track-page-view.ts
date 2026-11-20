import { useEffect } from "react";
import { trackPageView } from "../services";

// One view per page open; failures are silent.
export function useTrackPageView(pageId: string | undefined) {
  useEffect(() => {
    if (!pageId) return;
    const timer = setTimeout(() => {
      trackPageView(pageId).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pageId]);
}
