import React, { useState } from "react";
import { Switch, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
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

// Readers normally only read; this lets them open and answer comment
// threads in the space without granting edit rights.
export default function SpaceViewerCommentsToggle({ space }: Props) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(
    space.settings?.comments?.allowViewerComments === true,
  );
  const updateSpace = useUpdateSpaceMutation();

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      await updateSpace.mutateAsync({
        spaceId: space.id,
        allowViewerComments: value,
      });
      setChecked(value);
    } catch {
      // The mutation reports the failure.
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Allow viewers to comment")}</Text>
        <Text size="sm" c="dimmed">
          {t("Members with read-only access can comment on pages in this space.")}
        </Text>
      </ResponsiveSettingsContent>
      <ResponsiveSettingsControl>
        <Switch
          checked={checked}
          onChange={handleChange}
          size="xs"
          aria-label={t("Toggle viewer comments")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
