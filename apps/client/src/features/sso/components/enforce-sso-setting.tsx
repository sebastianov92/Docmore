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

interface EnforceSsoSettingProps {
  // Without an active provider the server refuses to enforce; the switch
  // stays off and explains why.
  hasActiveProvider: boolean;
}

export default function EnforceSsoSetting({
  hasActiveProvider,
}: EnforceSsoSettingProps) {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(workspace?.enforceSso === true);

  const apply = async (value: boolean) => {
    try {
      const updated = await updateWorkspace({ enforceSso: value });
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
      title: t("Enforce SSO"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            "Email and password login will be turned off for everyone, including you. Make sure you can sign in through the identity provider first.",
          )}
        </Text>
      ),
      labels: { confirm: t("Enforce SSO"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => apply(true),
    });
  };

  const disabled = !checked && !hasActiveProvider;

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Enforce SSO")}</Text>
        <Text size="sm" c="dimmed">
          {disabled
            ? t("Add and enable a provider first, then members can be required to use it.")
            : t("Once enforced, members will not be able to login with email and password.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          disabled={disabled}
          aria-label={t("Toggle sso enforcement")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
