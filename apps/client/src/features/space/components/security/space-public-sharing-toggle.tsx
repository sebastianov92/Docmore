import React, { useState } from "react";
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

// Per-space public sharing. Greyed out when the workspace already forbids
// it, since the stricter rule applies regardless.
export default function SpacePublicSharingToggle({ space }: Props) {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const workspaceDisabled = workspace?.settings?.sharing?.disabled === true;
  const [checked, setChecked] = useState(
    space.settings?.sharing?.disabled === true,
  );
  const updateSpace = useUpdateSpaceMutation();

  const apply = async (value: boolean) => {
    try {
      await updateSpace.mutateAsync({
        spaceId: space.id,
        disablePublicSharing: value,
      });
      setChecked(value);
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
      title: t("Disable public sharing"),
      centered: true,
      children: (
        <Text size="sm">
          {t("Public links to pages in this space will be deleted.")}
        </Text>
      ),
      labels: { confirm: t("Disable public sharing"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply(true),
    });
  };

  const workspaceNote = t("Public sharing is disabled at the workspace level.");

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Disable public sharing")}</Text>
        <Text size="sm" c="dimmed">
          {workspaceDisabled
            ? workspaceNote
            : t("Pages in this space cannot be published to a public link.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Tooltip label={workspaceNote} disabled={!workspaceDisabled} refProp="rootRef">
          <Switch
            checked={workspaceDisabled || checked}
            onChange={handleChange}
            disabled={workspaceDisabled}
            size="xs"
            aria-label={t("Toggle space public sharing")}
          />
        </Tooltip>
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
