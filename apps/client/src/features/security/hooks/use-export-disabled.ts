import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";

export interface ExportDisabledState {
  exportDisabled: boolean;
  // Why export is off, ready to show in a tooltip; null when it is allowed.
  exportDisabledLabel: string | null;
}

// Export can be switched off for the whole workspace (Settings > Security)
// or for one space (space settings). The workspace rule wins.
export function useExportDisabled(
  spaceIdOrSlug: string | undefined,
): ExportDisabledState {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const { data: space } = useGetSpaceBySlugQuery(spaceIdOrSlug);

  if (workspace?.settings?.export?.disabled) {
    return {
      exportDisabled: true,
      exportDisabledLabel: t("Export has been disabled at the workspace level."),
    };
  }

  if (space?.settings?.export?.disabled) {
    return {
      exportDisabled: true,
      exportDisabledLabel: t("Export has been disabled for this space."),
    };
  }

  return { exportDisabled: false, exportDisabledLabel: null };
}
