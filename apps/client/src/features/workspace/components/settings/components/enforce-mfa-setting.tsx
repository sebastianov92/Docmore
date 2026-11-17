import React, { useState } from "react";
import { Switch, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

export default function EnforceMfaSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(workspace?.enforceMfa === true);

  const apply = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ enforceMfa: value });
      setChecked(value);
      setWorkspace(updated);
    } catch (err) {
      notifications.show({
        message: (err as any)?.response?.data?.message,
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
      title: t("Require two-factor authentication"),
      centered: true,
      children: (
        <Text size="sm">
          {t("Every member without two-factor authentication will have to set it up the next time they sign in. Make sure you have set it up yourself first.")}
        </Text>
      ),
      labels: { confirm: t("Require it"), cancel: t("Cancel") },
      onConfirm: () => apply(true),
    });
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Require two-factor authentication")}</Text>
        <Text size="sm" c="dimmed">
          {t("Everyone must sign in with an authenticator app. Members without one set it up at their next login.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          aria-label={t("Toggle require two-factor authentication")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
