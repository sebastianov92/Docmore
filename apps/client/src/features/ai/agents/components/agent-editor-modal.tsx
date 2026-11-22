import { useEffect, useMemo, useState } from "react";
import { Button, Group, Modal, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { AGENT_PRESETS, AgentPreset } from "../presets";
import { browserTimeZone, WEEK_ORDER, weekdayName } from "../schedule-text";
import { AGENTS_KEY, createAgent, updateAgent } from "../services";
import { Agent, AgentInput, AgentOutputKind, AgentScheduleKind } from "../types";
import { PagePick, PickedPage } from "./page-pick";
import classes from "./agents.module.css";

type Draft = {
  name: string;
  instructions: string;
  spaceId: string | null;
  kind: AgentScheduleKind;
  hour: number;
  minute: number;
  weekdays: number[];
  dayOfMonth: number;
  timezone: string;
  outputKind: AgentOutputKind;
  outputSpaceId: string | null;
  parentPage: PickedPage | null;
  targetPage: PickedPage | null;
  allowEdits: boolean;
};

const ALL_SPACES = "__all";

function blank(): Draft {
  return {
    name: "",
    instructions: "",
    spaceId: null,
    kind: "weekly",
    hour: 8,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    timezone: browserTimeZone(),
    outputKind: "notify",
    outputSpaceId: null,
    parentPage: null,
    targetPage: null,
    allowEdits: false,
  };
}

function draftOf(agent: Agent): Draft {
  const page = agent.outputPage ? { id: agent.outputPage.id, title: agent.outputPage.title } : null;
  return {
    name: agent.name,
    instructions: agent.instructions,
    spaceId: agent.spaceId,
    kind: agent.schedule.kind,
    hour: agent.schedule.hour,
    minute: agent.schedule.minute,
    weekdays: agent.schedule.weekdays ?? [1],
    dayOfMonth: agent.schedule.dayOfMonth ?? 1,
    timezone: agent.schedule.timezone,
    outputKind: agent.output.kind,
    outputSpaceId: agent.output.spaceId ?? null,
    parentPage: agent.output.kind === "page" ? page : null,
    targetPage: agent.output.kind === "append" ? page : null,
    allowEdits: agent.allowEdits,
  };
}

function inputOf(draft: Draft): AgentInput {
  return {
    name: draft.name.trim(),
    instructions: draft.instructions.trim(),
    spaceId: draft.spaceId,
    schedule: {
      kind: draft.kind,
      hour: draft.hour,
      minute: draft.minute,
      timezone: draft.timezone,
      ...(draft.kind === "weekly" ? { weekdays: draft.weekdays } : {}),
      ...(draft.kind === "monthly" ? { dayOfMonth: draft.dayOfMonth } : {}),
    },
    output:
      draft.outputKind === "page"
        ? { kind: "page", spaceId: draft.outputSpaceId ?? draft.spaceId, parentPageId: draft.parentPage?.id ?? null }
        : draft.outputKind === "append"
          ? { kind: "append", pageId: draft.targetPage?.id ?? null }
          : { kind: "notify" },
    allowEdits: draft.allowEdits,
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: String(h).padStart(2, "0") }));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: String(i * 5), label: String(i * 5).padStart(2, "0") }));
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([current, browserTimeZone(), "UTC", ...zones])];
}

type Props = {
  opened: boolean;
  // null: a new agent
  agent: Agent | null;
  onClose: () => void;
};

// One agent: what it does, where it looks, when it runs and where its result goes.
export function AgentEditorModal({ opened, agent, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const workspace = useAtomValue(workspaceAtom);
  const suggestEdits = workspace?.settings?.ai?.editsAsSuggestions !== false;
  const [draft, setDraft] = useState<Draft>(blank);
  const [preset, setPreset] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    if (!opened) return;
    setDraft(agent ? draftOf(agent) : blank());
    setPreset(null);
  }, [opened, agent]);

  const spaces = useGetSpacesQuery({ limit: 100 });
  const spaceOptions = useMemo(() => (spaces.data?.items ?? []).map((s) => ({ value: s.id, label: s.name })), [spaces.data]);
  const zones = useMemo(() => timeZones(draft.timezone), [draft.timezone]);

  const usePreset = (p: AgentPreset) => {
    setPreset(p.id);
    set({
      name: t(p.name),
      instructions: t(p.instructions),
      kind: p.schedule.kind,
      hour: p.schedule.hour,
      minute: p.schedule.minute,
      weekdays: p.schedule.weekdays ?? [1],
      dayOfMonth: p.schedule.dayOfMonth ?? 1,
      outputKind: p.output,
    });
  };

  const save = useMutation({
    mutationFn: () => (agent ? updateAgent(agent.id, inputOf(draft)) : createAgent(inputOf(draft))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
      notifications.show({ message: agent ? t("Agent saved") : t("Agent created") });
      onClose();
    },
    onError: (err) => notifications.show({ color: "red", message: getApiErrorMessage(err, t("Could not save the agent")) }),
  });

  const outputSpace = draft.outputSpaceId ?? draft.spaceId;
  const problem =
    !draft.name.trim()
      ? t("Give the agent a name")
      : draft.instructions.trim().length < 10
        ? t("Say what the agent should do")
        : draft.kind === "weekly" && draft.weekdays.length === 0
          ? t("Pick at least one day of the week")
          : draft.outputKind === "page" && !outputSpace
            ? t("Pick the space where the pages go")
            : draft.outputKind === "append" && !draft.targetPage
              ? t("Pick the page the results are added to")
              : null;

  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={agent ? t("Edit agent") : t("New agent")} data-testid="agent-editor">
      <Stack gap="lg">
        {!agent && (
          <div className={classes.section}>
            <Text className={classes.sectionLabel}>{t("Start from")}</Text>
            <div className={classes.presets}>
              {AGENT_PRESETS.map((p) => (
                <UnstyledButton key={p.id} className={classes.preset} data-active={preset === p.id || undefined} onClick={() => usePreset(p)} data-testid={`agent-preset-${p.id}`}>
                  <span className={classes.presetName}>{t(p.name)}</span>
                  <span className={classes.presetText}>{t(p.description)}</span>
                </UnstyledButton>
              ))}
            </div>
          </div>
        )}

        <TextInput label={t("Name")} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} maxLength={100} data-testid="agent-name" />
        <Textarea
          label={t("Task")}
          description={t("Write it as you would ask a colleague. The agent works alone: it cannot ask you anything.")}
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.currentTarget.value })}
          autosize
          minRows={4}
          maxRows={12}
          maxLength={6000}
          data-testid="agent-task"
        />

        <div className={classes.section}>
          <Text className={classes.sectionLabel}>{t("Where it looks")}</Text>
          <Select
            data={[{ value: ALL_SPACES, label: t("Every space I can see") }, ...spaceOptions]}
            value={draft.spaceId ?? ALL_SPACES}
            onChange={(v) => set({ spaceId: !v || v === ALL_SPACES ? null : v, parentPage: null })}
            allowDeselect={false}
            searchable
            comboboxProps={{ withinPortal: true }}
            aria-label={t("Where it looks")}
            data-testid="agent-scope"
          />
        </div>

        <div className={classes.section}>
          <Text className={classes.sectionLabel}>{t("When it runs")}</Text>
          <SegmentedControl
            value={draft.kind}
            onChange={(v) => set({ kind: v as AgentScheduleKind })}
            data={[
              { value: "daily", label: t("Every day") },
              { value: "weekly", label: t("Days of the week") },
              { value: "monthly", label: t("Once a month") },
            ]}
            data-testid="agent-frequency"
          />
          {draft.kind === "weekly" && (
            <div className={classes.days} role="group" aria-label={t("Days of the week")}>
              {WEEK_ORDER.map((day) => {
                const active = draft.weekdays.includes(day);
                return (
                  <UnstyledButton
                    key={day}
                    className={classes.day}
                    data-active={active || undefined}
                    aria-pressed={active}
                    onClick={() => set({ weekdays: active ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day] })}
                    data-testid={`agent-day-${day}`}
                  >
                    {weekdayName(day, i18n.language, "short")}
                  </UnstyledButton>
                );
              })}
            </div>
          )}
          <Group gap="sm" align="flex-end" wrap="wrap">
            {draft.kind === "monthly" && (
              <Select
                label={t("Day")}
                data={MONTH_DAYS}
                value={String(draft.dayOfMonth)}
                onChange={(v) => set({ dayOfMonth: Number(v ?? 1) })}
                allowDeselect={false}
                w={90}
                comboboxProps={{ withinPortal: true }}
                data-testid="agent-month-day"
              />
            )}
            <Select
              label={t("Hour")}
              data={HOURS}
              value={String(draft.hour)}
              onChange={(v) => set({ hour: Number(v ?? 8) })}
              allowDeselect={false}
              w={90}
              comboboxProps={{ withinPortal: true }}
              data-testid="agent-hour"
            />
            <Select
              label={t("Minute")}
              data={MINUTES.some((m) => m.value === String(draft.minute)) ? MINUTES : [...MINUTES, { value: String(draft.minute), label: String(draft.minute).padStart(2, "0") }]}
              value={String(draft.minute)}
              onChange={(v) => set({ minute: Number(v ?? 0) })}
              allowDeselect={false}
              w={90}
              comboboxProps={{ withinPortal: true }}
              data-testid="agent-minute"
            />
            <Select
              label={t("Time zone")}
              data={zones}
              value={draft.timezone}
              onChange={(v) => set({ timezone: v ?? browserTimeZone() })}
              allowDeselect={false}
              searchable
              style={{ flex: 1, minWidth: 200 }}
              comboboxProps={{ withinPortal: true }}
              data-testid="agent-timezone"
            />
          </Group>
        </div>

        <div className={classes.section}>
          <Text className={classes.sectionLabel}>{t("Where the result goes")}</Text>
          <SegmentedControl
            value={draft.outputKind}
            onChange={(v) => set({ outputKind: v as AgentOutputKind })}
            data={[
              { value: "notify", label: t("A notification") },
              { value: "page", label: t("A new page each time") },
              { value: "append", label: t("Added to a page") },
            ]}
            data-testid="agent-output"
          />
          {draft.outputKind === "notify" && (
            <Text size="xs" c="dimmed">
              {t("You get a notification with the result; it is also kept in the agent's history.")}
            </Text>
          )}
          {draft.outputKind === "page" && (
            <Group gap="sm" align="flex-end" grow wrap="wrap">
              <Select
                label={t("Space")}
                data={spaceOptions}
                value={outputSpace}
                onChange={(v) => set({ outputSpaceId: v, parentPage: null })}
                disabled={Boolean(draft.spaceId)}
                allowDeselect={false}
                searchable
                placeholder={t("Choose a space")}
                comboboxProps={{ withinPortal: true }}
                data-testid="agent-output-space"
              />
              <div>
                <Text size="sm" fw={500} mb={4}>
                  {t("Under the page")}
                </Text>
                <PagePick
                  value={draft.parentPage}
                  onChange={(page) => set({ parentPage: page })}
                  spaceId={outputSpace}
                  placeholder={t("At the top of the space")}
                  noneLabel={t("At the top of the space")}
                  testId="agent-parent-page"
                />
              </div>
            </Group>
          )}
          {draft.outputKind === "append" && (
            <>
              <PagePick
                value={draft.targetPage}
                onChange={(page) => set({ targetPage: page })}
                spaceId={draft.spaceId}
                placeholder={t("Choose a page")}
                testId="agent-target-page"
              />
              <Text size="xs" c="dimmed">
                {suggestEdits
                  ? t("Each result is proposed as a suggestion on that page, under the date; it is added when someone accepts it.")
                  : t("Each result is added at the end of that page, under the date.")}
              </Text>
            </>
          )}
        </div>

        <Switch
          checked={draft.allowEdits}
          onChange={(e) => set({ allowEdits: e.currentTarget.checked })}
          label={t("It may create pages and rows on its own")}
          description={
            suggestEdits
              ? t("Off: it only reads. On: it can also create pages, add rows to bases and propose changes to existing pages as suggestions.")
              : t("Off: it only reads. On: it can also create and change pages and rows.")
          }
          data-testid="agent-allow-edits"
        />

        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="red">
            {problem ?? ""}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={Boolean(problem)} data-testid="agent-save">
              {agent ? t("Save") : t("Create agent")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
