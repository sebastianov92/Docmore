import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFilePlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { SpaceSelect } from "@/features/space/components/sidebar/space-select";
import { IResearchSource, saveResearchAsPage } from "@/features/ai/research/services";
import { getApiErrorMessage } from "@/lib/api-error";
import classes from "./chat.module.css";

// The numbered pages a report cites, and a way to keep the report as a page.
export function ResearchSources({ reportId, sources, savedPageUrl }: { reportId: string; sources: IResearchSource[]; savedPageUrl?: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(savedPageUrl ?? null);

  const save = async () => {
    if (!spaceId) return;
    setSaving(true);
    try {
      const page = await saveResearchAsPage({ reportId, spaceId });
      setSaved(page.url);
      setOpen(false);
      notifications.show({ message: t("Report saved as a page") });
    } catch (err) {
      notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not save the report")) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={classes.sources} data-testid="research-sources">
      <Group justify="space-between" align="center" gap="xs">
        <Text size="xs" fw={600}>
          {t("{{count}} sources", { count: sources.length })}
        </Text>
        {saved ? (
          <Button size="compact-xs" variant="subtle" onClick={() => navigate(saved)}>
            {t("Open the saved page")}
          </Button>
        ) : (
          <Button size="compact-xs" variant="default" leftSection={<IconFilePlus size={12} />} onClick={() => setOpen(true)}>
            {t("Save as page")}
          </Button>
        )}
      </Group>
      <ol>
        {sources.map((s) => (
          <li key={s.n}>
            <a
              href={s.url}
              onClick={(e) => {
                e.preventDefault();
                navigate(s.url);
              }}
            >
              {s.title || t("Untitled")}
            </a>
          </li>
        ))}
      </ol>
      <Modal opened={open} onClose={() => setOpen(false)} title={t("Save the report as a page")} size="sm">
        <Stack gap="md">
          <SpaceSelect label={t("Space")} onChange={(space) => setSpaceId(space.id)} />
          <Group justify="flex-end">
            <Button onClick={save} loading={saving} disabled={!spaceId}>
              {t("Save")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
