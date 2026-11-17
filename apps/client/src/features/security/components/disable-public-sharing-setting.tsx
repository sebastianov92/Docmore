import React, { useState } from "react";
import { Switch, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

// Workspace-wide switch. Turning it on also removes every public share
// link, so that direction asks first.
export default function DisablePublicSharingSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(
    workspace?.settings?.sharing?.disabled === true,
  );

  const apply = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ disablePublicSharing: value });
      setChecked(value);
      setWorkspace(updated);
    } catch (err) {
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to update setting")),
        color: "red",
      });
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
          {t(
            "Every public link in this workspace will be deleted and nobody will be able to share pages publicly until this is turned back on.",
          )}
        </Text>
      ),
      labels: { confirm: t("Disable public sharing"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply(true),
    });
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Disable public sharing")}</Text>
        <Text size="sm" c="dimmed">
          {t("Nobody can publish pages to a public link. Existing links are removed.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          aria-label={t("Toggle public sharing")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
