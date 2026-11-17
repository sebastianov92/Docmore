import React from "react";
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

// Workspace-wide switch over page, space and print export. Admins are not
// exempt, which is why turning it on asks first.
export default function DisableExportSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const checked = workspace?.settings?.export?.disabled === true;

  const apply = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ disableExport: value });
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
      title: t("Disable export"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            "Nobody in this workspace, admins included, will be able to export or print pages until this is turned back on.",
          )}
        </Text>
      ),
      labels: { confirm: t("Disable export"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply(true),
    });
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Disable export")}</Text>
        <Text size="sm" c="dimmed">
          {t("Hides export and print for every page and space. The API refuses exports too.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          aria-label={t("Toggle export")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
