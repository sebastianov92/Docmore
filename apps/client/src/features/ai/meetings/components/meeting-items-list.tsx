import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Loader, SegmentedControl, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChecks, IconLock, IconPlus, IconSquareCheck } from "@tabler/icons-react";
import clsx from "clsx";
import { IMeetingItem, MeetingItemOp } from "../services";
import classes from "./meeting-items-list.module.css";

// building: the model is reading new text; waiting: nothing to read yet;
// unavailable: no model, or it cannot be reached; none: not a live list
export type MeetingListState = "building" | "waiting" | "unavailable" | "none";

type Draft = { kind: "agreement" | "task"; text: string; owner: string; due: string };

function describe(v: { text: string; owner: string | null; due: string | null }): string {
  return `${v.text}${v.owner ? ` — ${v.owner}` : ""}${v.due ? ` · ${v.due}` : ""}`;
}

// What the entry first said, when the meeting itself changed it afterwards.
// A rewording by the person is not the meeting changing its mind.
export function previousVersion(item: IMeetingItem): string | null {
  const versions = [...item.history, { text: item.text, owner: item.owner, due: item.due, status: item.status, by: item.updatedBy }];
  const now = describe(item);
  for (let i = 0; i < versions.length - 1; i += 1) {
    const changedByMeeting = versions.slice(i + 1).some((v) => v.by === "ai");
    if (changedByMeeting && versions[i].status === "active" && describe(versions[i]) !== now) return describe(versions[i]);
  }
  return null;
}

function ItemForm({ initial, onSave, onClose, extra }: { initial: Draft; onSave: (d: Draft) => void; onClose: () => void; extra?: React.ReactNode }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(initial);
  const save = () => {
    if (draft.text.trim()) onSave({ ...draft, text: draft.text.trim() });
  };
  return (
    <Stack gap={6} className={classes.form} data-testid="meeting-item-form">
      <SegmentedControl
        size="xs"
        value={draft.kind}
        onChange={(v) => setDraft({ ...draft, kind: v as Draft["kind"] })}
        data={[
          { value: "agreement", label: t("Agreement") },
          { value: "task", label: t("Task") },
        ]}
      />
      <TextInput
        size="xs"
        autoFocus
        placeholder={t("What was agreed")}
        aria-label={t("What was agreed")}
        value={draft.text}
        onChange={(e) => setDraft({ ...draft, text: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onClose();
        }}
        data-testid="meeting-item-text"
      />
      <Group gap={6} grow>
        <TextInput size="xs" placeholder={t("Who does it")} aria-label={t("Who does it")} value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.currentTarget.value })} />
        <TextInput size="xs" placeholder={t("By when")} aria-label={t("By when")} value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.currentTarget.value })} />
      </Group>
      <Group gap={6} justify="space-between">
        <Group gap={6}>{extra}</Group>
        <Group gap={6}>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button size="compact-xs" onClick={save} disabled={!draft.text.trim()} data-testid="meeting-item-save">
            {t("Save")}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

// The agreements and tasks of a meeting. A row opens its own small form;
// what the person touches there is theirs from then on.
export function MeetingItemsList({ items, state, onOp }: { items: IMeetingItem[]; state: MeetingListState; onOp?: (op: MeetingItemOp) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);

  const status =
    state === "building"
      ? t("Reading what was just said…")
      : state === "unavailable"
        ? t("The list is made when the meeting ends.")
        : state === "waiting" && items.length === 0
          ? t("Agreements and tasks show here as they are made.")
          : "";

  return (
    <Stack gap={4} data-testid="meeting-items">
      {items.map((item) =>
        editing === item.id && onOp ? (
          <ItemForm
            key={item.id}
            initial={{ kind: item.kind, text: item.text, owner: item.owner ?? "", due: item.due ?? "" }}
            onClose={() => setEditing(null)}
            onSave={(d) => {
              onOp({ op: "update", id: item.id, kind: d.kind, text: d.text, owner: d.owner.trim() || null, due: d.due.trim() || null });
              setEditing(null);
            }}
            extra={
              <>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() => {
                    onOp({ op: item.status === "cancelled" ? "restore" : "cancel", id: item.id });
                    setEditing(null);
                  }}
                >
                  {item.status === "cancelled" ? t("Restore") : t("Call off")}
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    onOp({ op: "remove", id: item.id });
                    setEditing(null);
                  }}
                >
                  {t("Delete")}
                </Button>
              </>
            }
          />
        ) : (
          <UnstyledButton
            key={item.id}
            className={clsx(classes.row, item.status === "cancelled" && classes.cancelled)}
            onClick={() => onOp && setEditing(item.id)}
            disabled={!onOp}
            data-testid="meeting-item"
            data-kind={item.kind}
            data-status={item.status}
          >
            {item.kind === "task" ? (
              <IconSquareCheck size={16} style={{ flex: "none", marginTop: 2 }} aria-label={t("Task")} />
            ) : (
              <IconChecks size={16} style={{ flex: "none", marginTop: 2 }} aria-label={t("Agreement")} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" className={classes.text}>
                {item.text}
              </Text>
              {(item.owner || item.due) && (
                <Text size="xs" c="dimmed" className={classes.text}>
                  {[item.owner, item.due].filter(Boolean).join(" · ")}
                </Text>
              )}
              {item.status === "active" && previousVersion(item) && (
                <Text size="xs" c="dimmed" fs="italic" className={classes.text} data-testid="meeting-item-before">
                  {t("Before: {{text}}", { text: previousVersion(item) })}
                </Text>
              )}
              {item.status === "cancelled" && (
                <Text size="xs" c="dimmed">
                  {t("Called off")}
                </Text>
              )}
            </div>
            {item.locked && (
              <Tooltip label={t("You edited this: the AI leaves it as it is")} withArrow>
                <IconLock size={14} style={{ flex: "none", marginTop: 3 }} aria-label={t("Edited by you")} />
              </Tooltip>
            )}
          </UnstyledButton>
        ),
      )}
      {onOp &&
        (editing === "new" ? (
          <ItemForm
            initial={{ kind: "agreement", text: "", owner: "", due: "" }}
            onClose={() => setEditing(null)}
            onSave={(d) => {
              onOp({ op: "add", kind: d.kind, text: d.text, owner: d.owner.trim() || null, due: d.due.trim() || null });
              setEditing(null);
            }}
          />
        ) : (
          <UnstyledButton className={classes.add} onClick={() => setEditing("new")} data-testid="meeting-item-add">
            <IconPlus size={14} />
            <Text size="sm">{t("Add an agreement or a task")}</Text>
          </UnstyledButton>
        ))}
      {status && (
        <Group gap={6} wrap="nowrap" mt={2}>
          {state === "building" && <Loader size={12} />}
          <Text size="xs" c="dimmed" data-testid="meeting-items-status">
            {status}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
