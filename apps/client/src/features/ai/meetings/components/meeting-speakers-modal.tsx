import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Group, Loader, Menu, Modal, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowMerge, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { getApiErrorMessage } from "@/lib/api-error";
import { IMeetingDetail, IMeetingSpeaker, mergeMeetingSpeakers, meetingsOfPage, renameMeetingSpeaker } from "../services";

const COLORS = ["blue", "teal", "grape", "orange", "pink", "cyan", "lime", "indigo"];

export function speakerColor(speaker: { number: number }): string {
  return COLORS[(speaker.number - 1) % COLORS.length];
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function meetingsOfPageKey(pageId: string) {
  return ["meeting-speakers", pageId];
}

// The meetings on a page that have speakers to name.
export function useMeetingsOfPage(pageId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: meetingsOfPageKey(pageId ?? ""),
    queryFn: () => meetingsOfPage(pageId as string),
    enabled: enabled && Boolean(pageId),
    staleTime: 30_000,
    retry: false,
  });
}

function SpeakerRow({ meeting, speaker, onChanged }: { meeting: IMeetingDetail; speaker: IMeetingSpeaker; onChanged: (m: IMeetingDetail) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(speaker.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(speaker.name ?? ""), [speaker.name]);

  const save = async () => {
    const next = name.trim();
    if (next === (speaker.name ?? "") || saving) return;
    setSaving(true);
    try {
      onChanged(await renameMeetingSpeaker(meeting.id, speaker.id, next));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not save the name")) });
    } finally {
      setSaving(false);
    }
  };

  const merge = async (into: IMeetingSpeaker) => {
    try {
      onChanged(await mergeMeetingSpeakers(meeting.id, speaker.id, into.id));
    } catch (err) {
      notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not join the two speakers")) });
    }
  };

  const others = meeting.speakers.filter((s) => s.id !== speaker.id);
  return (
    <Stack gap={4} data-testid="meeting-speaker" data-speaker={speaker.id}>
      <Group gap="xs" wrap="nowrap" align="center">
        <span style={{ width: 10, height: 10, borderRadius: 10, flex: "none", background: `var(--mantine-color-${speakerColor(speaker)}-6)` }} />
        <TextInput
          style={{ flex: 1, minWidth: 0 }}
          size="sm"
          value={name}
          placeholder={speaker.name ? t("Name") : speaker.label}
          aria-label={t("Name of {{label}}", { label: speaker.label })}
          readOnly={!meeting.canManage}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          rightSection={saving ? <Loader size={14} /> : saved ? <IconCheck size={14} /> : null}
          maxLength={80}
          data-testid="meeting-speaker-name"
        />
        {speaker.side && (
          <Badge variant="light" color={speaker.side === "remote" ? "grape" : "gray"} style={{ flex: "none" }}>
            {speaker.side === "remote" ? t("Remote") : t("Room")}
          </Badge>
        )}
        {meeting.canManage && others.length > 0 && (
          <Menu position="bottom-end" width={260} shadow="md" withinPortal>
            <Menu.Target>
              <Button size="xs" variant="default" leftSection={<IconArrowMerge size={14} />} style={{ flex: "none" }} data-testid="meeting-speaker-merge">
                {t("Same person as")}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {others.map((o) => (
                <Menu.Item key={o.id} onClick={() => merge(o)} data-testid="meeting-speaker-merge-into">
                  {o.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <Text size="xs" c="dimmed" pl={22} style={{ overflowWrap: "anywhere" }}>
        {t("Spoke {{time}}", { time: clock(speaker.seconds) })}
        {speaker.sample ? ` · “${speaker.sample}”` : ""}
      </Text>
    </Stack>
  );
}

// Who is who in the meetings recorded on a page: a name typed here replaces
// the label everywhere in that meeting's notes.
export function MeetingSpeakersModal({ pageId, opened, onClose }: { pageId: string; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useMeetingsOfPage(pageId, opened);
  const meetings = (data ?? []).filter((m) => m.speakers.length > 0);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const meeting = meetings.find((m) => m.id === pickedId) ?? meetings[0];

  const onChanged = (next: IMeetingDetail) => {
    queryClient.setQueryData<IMeetingDetail[]>(meetingsOfPageKey(pageId), (prev) => (prev ?? []).map((m) => (m.id === next.id ? next : m)));
  };

  const title = (m: IMeetingDetail) => `${m.fileName || t("Meeting")} · ${new Date(m.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;

  return (
    <Modal opened={opened} onClose={onClose} title={t("People in the meeting")} size="lg" data-testid="meeting-speakers">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("Give each voice its name. The name replaces the label everywhere in the notes of that meeting.")}
        </Text>
        {isLoading && <Loader size="sm" />}
        {!isLoading && !meeting && <Text size="sm">{t("This page has no meeting with voices told apart.")}</Text>}
        {meetings.length > 1 && meeting && (
          <Menu position="bottom-start" width={360} shadow="md" withinPortal>
            <Menu.Target>
              <UnstyledButton
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--mantine-color-default-border)" }}
                data-testid="meeting-speakers-pick"
              >
                <Text size="sm" truncate>
                  {title(meeting)}
                </Text>
                <IconChevronDown size={14} style={{ flex: "none" }} />
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {meetings.map((m) => (
                <Menu.Item key={m.id} onClick={() => setPickedId(m.id)} rightSection={m.id === meeting.id ? <IconCheck size={14} /> : null}>
                  {title(m)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
        {meeting && (
          <Stack gap="sm">
            {meeting.speakers.map((s) => (
              <SpeakerRow key={`${meeting.id}:${s.id}`} meeting={meeting} speaker={s} onChanged={onChanged} />
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
