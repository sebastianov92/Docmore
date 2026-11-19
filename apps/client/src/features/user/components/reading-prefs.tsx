import React, { useState } from "react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { SegmentedControl, Select, Switch, Text } from "@mantine/core";
import { userAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateUser } from "@/features/user/services/user-service.ts";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row";

type PageFont = "default" | "serif" | "mono";
type PageTextSize = "small" | "normal" | "large";

// Typeface and text size of pages, per user. Applied through data
// attributes on <html> (see UserPreferenceEffects) and reading-prefs.css.
export function usePageFontPref() {
  const [user, setUser] = useAtom(userAtom);
  const font: PageFont = user?.settings?.preferences?.pageFont ?? "default";
  const size: PageTextSize = user?.settings?.preferences?.pageTextSize ?? "normal";
  const setFont = async (pageFont: PageFont) => {
    const updated = await updateUser({ pageFont } as any);
    setUser(updated);
  };
  const setSize = async (pageTextSize: PageTextSize) => {
    const updated = await updateUser({ pageTextSize } as any);
    setUser(updated);
  };
  return { font, size, setFont, setSize };
}

export function PageFontControl({ size = "xs" }: { size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  const pref = usePageFontPref();
  return (
    <SegmentedControl
      size={size}
      value={pref.font}
      onChange={(v) => pref.setFont(v as PageFont)}
      data={[
        { value: "default", label: t("Default") },
        { value: "serif", label: <span style={{ fontFamily: "Georgia, serif" }}>Serif</span> },
        { value: "mono", label: <span style={{ fontFamily: "ui-monospace, monospace" }}>Mono</span> },
      ]}
      aria-label={t("Page font")}
    />
  );
}

export function PageTextSizeControl({ size = "xs" }: { size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  const pref = usePageFontPref();
  return (
    <SegmentedControl
      size={size}
      value={pref.size}
      onChange={(v) => pref.setSize(v as PageTextSize)}
      data={[
        { value: "small", label: "S" },
        { value: "normal", label: "M" },
        { value: "large", label: "L" },
      ]}
      aria-label={t("Text size")}
    />
  );
}

export function PageFontPref() {
  const { t } = useTranslation();
  const pref = usePageFontPref();
  return (
    <>
      <ResponsiveSettingsRow>
        <ResponsiveSettingsContent>
          <Text size="md">{t("Page font")}</Text>
          <Text size="sm" c="dimmed">
            {t("Typeface used for page content.")}
          </Text>
        </ResponsiveSettingsContent>
        <ResponsiveSettingsControl>
          <Select
            data={[
              { value: "default", label: t("Default") },
              { value: "serif", label: "Serif" },
              { value: "mono", label: "Mono" },
            ]}
            value={pref.font}
            onChange={(v) => v && pref.setFont(v as PageFont)}
            allowDeselect={false}
            checkIconPosition="right"
            aria-label={t("Page font")}
          />
        </ResponsiveSettingsControl>
      </ResponsiveSettingsRow>
      <ResponsiveSettingsRow>
        <ResponsiveSettingsContent>
          <Text size="md">{t("Text size")}</Text>
          <Text size="sm" c="dimmed">
            {t("Size of the text in pages.")}
          </Text>
        </ResponsiveSettingsContent>
        <ResponsiveSettingsControl>
          <Select
            data={[
              { value: "small", label: t("Small") },
              { value: "normal", label: t("Normal") },
              { value: "large", label: t("Large") },
            ]}
            value={pref.size}
            onChange={(v) => v && pref.setSize(v as PageTextSize)}
            allowDeselect={false}
            checkIconPosition="right"
            aria-label={t("Text size")}
          />
        </ResponsiveSettingsControl>
      </ResponsiveSettingsRow>
    </>
  );
}

// Stronger text and borders on top of the light or dark theme.
export function HighContrastPref() {
  const { t } = useTranslation();
  const [user, setUser] = useAtom(userAtom);
  const [checked, setChecked] = useState(
    user?.settings?.preferences?.highContrast === true,
  );
  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setChecked(value);
    try {
      const updated = await updateUser({ highContrast: value } as any);
      setUser(updated);
    } catch {
      setChecked(!value);
    }
  };
  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("High contrast")}</Text>
        <Text size="sm" c="dimmed">
          {t("Darker text and stronger borders on top of the light or dark theme.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          aria-label={t("Toggle high contrast")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
