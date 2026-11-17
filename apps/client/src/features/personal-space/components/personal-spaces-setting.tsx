import React, { useState } from "react";
import { Switch, Text } from "@mantine/core";
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

// Settings > General. Spaces already created stay when this is turned off;
// only new ones are refused.
export default function PersonalSpacesSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(
    workspace?.settings?.spaces?.allowPersonal === true,
  );

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      const updated = await updateWorkspace({ allowPersonalSpaces: value });
      setChecked(value);
      setWorkspace(updated);
    } catch (err) {
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to update setting")),
        color: "red",
      });
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Allow personal spaces")}</Text>
        <Text size="sm" c="dimmed">
          {t("Each member can create one private space of their own from the workspace menu.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          aria-label={t("Toggle allow personal spaces")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
