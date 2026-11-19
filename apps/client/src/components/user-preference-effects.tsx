import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom.ts";

// Mirrors reading preferences onto <html> so plain CSS can style pages:
// data-page-font, data-page-text-size, data-contrast.
export function UserPreferenceEffects() {
  const user = useAtomValue(userAtom);
  const prefs = user?.settings?.preferences;
  const font = prefs?.pageFont ?? "default";
  const size = prefs?.pageTextSize ?? "normal";
  const contrast = prefs?.highContrast === true;

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.pageFont = font;
    el.dataset.pageTextSize = size;
    if (contrast) el.dataset.contrast = "high";
    else delete el.dataset.contrast;
  }, [font, size, contrast]);

  return null;
}
