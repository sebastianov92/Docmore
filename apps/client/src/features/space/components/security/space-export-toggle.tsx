import React from "react";
import { Switch, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { useUpdateSpaceMutation } from "@/features/space/queries/space-query.ts";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

interface Props {
  space: ISpace;
}

// Per-space export switch; the mutation refreshes the space, so the
// checked state comes straight from it.
export default function SpaceExportToggle({ space }: Props) {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const workspaceDisabled = workspace?.settings?.export?.disabled === true;
  const checked = space.settings?.export?.disabled === true;
  const updateSpace = useUpdateSpaceMutation();

  const apply = async (value: boolean) => {
    try {
      await updateSpace.mutateAsync({ spaceId: space.id, disableExport: value });
    } catch {
      // The mutation reports the failure.
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    if (!value) {
      apply(false);
      return;
    }
    modals.openConfirmModal({
      title: t("Disable export"),
      centered: true,
      children: (
        <Text size="sm">
          {t("Nobody, admins included, will be able to export or print pages from this space.")}
        </Text>
      ),
      labels: { confirm: t("Disable export"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply(true),
    });
  };

  const workspaceNote = t("Export has been disabled at the workspace level.");

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Disable export")}</Text>
        <Text size="sm" c="dimmed">
          {workspaceDisabled
            ? workspaceNote
            : t("Pages in this space cannot be exported or printed.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Tooltip label={workspaceNote} disabled={!workspaceDisabled} refProp="rootRef">
          <Switch
            checked={workspaceDisabled || checked}
            onChange={handleChange}
            disabled={workspaceDisabled}
            size="xs"
            aria-label={t("Toggle space export")}
          />
        </Tooltip>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
