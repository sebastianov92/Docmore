import { useState } from "react";
import { useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ActionIcon, Badge, Button, Checkbox, Group, Menu, Paper, SimpleGrid, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconAdjustments, IconCalendarEvent, IconChecklist, IconExternalLink, IconLink, IconX } from "@tabler/icons-react";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { updateUser } from "@/features/user/services/user-service";
import { DEFAULT_HOME_WIDGETS, getMyWork, IMyWorkItem } from "../services";
import { useShortcuts } from "../hooks/use-shortcuts";

const ALL: { id: string; labelKey: string }[] = [
  { id: "tasks", labelKey: "My tasks" },
  { id: "upcoming", labelKey: "Coming up" },
  { id: "shortcuts", labelKey: "Shortcuts" },
];

// The home widgets: the rows assigned to you across bases, what is due
// soon, and your shortcuts. "Customize" picks which ones show.
export default function HomeWidgets() {
  const { t } = useTranslation();
  const [user, setUser] = useAtom(userAtom);
  const enabled = user?.settings?.preferences?.homeWidgets ?? DEFAULT_HOME_WIDGETS;
  const work = useQuery({ queryKey: ["my-work"], queryFn: () => getMyWork(7), staleTime: 60_000, enabled: enabled.includes("tasks") || enabled.includes("upcoming") });
  const toggle = async (id: string) => {
    const next = enabled.includes(id) ? enabled.filter((w) => w !== id) : [...enabled, id];
    const updated = await updateUser({ homeWidgets: next } as any);
    setUser(updated);
  };
  const shown = ALL.filter((w) => enabled.includes(w.id));

  return (
    <div data-testid="home-widgets">
      <Group justify="space-between" mb="xs">
        <Text size="sm" fw={600} c="dimmed">
          {t("Your day")}
        </Text>
        <Menu position="bottom-end" withinPortal closeOnItemClick={false}>
          <Menu.Target>
            <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconAdjustments size={14} />} data-testid="home-customize">
              {t("Customize")}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {ALL.map((w) => (
              <Menu.Item key={w.id} onClick={() => toggle(w.id)}>
                <Checkbox size="xs" readOnly checked={enabled.includes(w.id)} label={t(w.labelKey)} />
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
      {shown.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("No widgets. Pick some under Customize.")}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: Math.min(shown.length, 3) }} spacing="md">
          {shown.map((w) =>
            w.id === "tasks" ? (
              <WorkWidget key={w.id} title={t("My tasks")} icon={<IconChecklist size={16} />} items={work.data?.tasks ?? []} empty={t("Nothing assigned to you.")} loading={work.isLoading} showDate />
            ) : w.id === "upcoming" ? (
              <WorkWidget key={w.id} title={t("Coming up")} icon={<IconCalendarEvent size={16} />} items={work.data?.upcoming ?? []} empty={t("Nothing due in the next week.")} loading={work.isLoading} showDate />
            ) : (
              <ShortcutsWidget key={w.id} />
            ),
          )}
        </SimpleGrid>
      )}
    </div>
  );
}

function WorkWidget({ title, icon, items, empty, loading, showDate }: { title: string; icon: React.ReactNode; items: IMyWorkItem[]; empty: string; loading: boolean; showDate?: boolean }) {
  const { t } = useTranslation();
  return (
    <Paper withBorder radius="md" p="sm" data-testid="home-widget">
      <Group gap={6} mb="xs">
        {icon}
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <Badge size="xs" variant="light" color="gray">
          {items.length}
        </Badge>
      </Group>
      <Stack gap={4}>
        {loading && (
          <Text size="xs" c="dimmed">
            {t("Loading…")}
          </Text>
        )}
        {!loading && items.length === 0 && (
          <Text size="xs" c="dimmed">
            {empty}
          </Text>
        )}
        {items.slice(0, 8).map((it) => (
          <Link key={it.rowId} to={it.url} style={{ textDecoration: "none", color: "inherit" }}>
            <Group gap={6} wrap="nowrap" justify="space-between">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" truncate>
                  {it.title}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {it.pageTitle}
                </Text>
              </div>
              <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                {it.status && (
                  <Badge size="xs" variant="light" color={it.status.color ?? "gray"} style={{ textTransform: "none" }}>
                    {it.status.name}
                  </Badge>
                )}
                {showDate && it.date && (
                  <Text size="xs" c="dimmed">
                    {new Date(it.date).toLocaleDateString()}
                  </Text>
                )}
              </Group>
            </Group>
          </Link>
        ))}
        {items.length > 8 && (
          <Text size="xs" c="dimmed">
            {t("and {{count}} more", { count: items.length - 8 })}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function ShortcutsWidget() {
  const { t } = useTranslation();
  const { shortcuts, add, remove } = useShortcuts();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const save = async () => {
    if (!title.trim() || !url.trim()) return;
    await add({ type: "url", title: title.trim(), url: url.trim() });
    setTitle("");
    setUrl("");
    setAdding(false);
  };
  return (
    <Paper withBorder radius="md" p="sm" data-testid="home-widget">
      <Group gap={6} mb="xs" justify="space-between">
        <Group gap={6}>
          <IconLink size={16} />
          <Text size="sm" fw={600}>
            {t("Shortcuts")}
          </Text>
        </Group>
        <Button size="compact-xs" variant="subtle" onClick={() => setAdding((a) => !a)} data-testid="shortcut-add">
          {t("Add link")}
        </Button>
      </Group>
      {adding && (
        <Stack gap={4} mb="xs">
          <TextInput size="xs" placeholder={t("Title")} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <TextInput size="xs" placeholder="https://" value={url} onChange={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <Button size="compact-xs" onClick={save} disabled={!title.trim() || !url.trim()}>
            {t("Save")}
          </Button>
        </Stack>
      )}
      <Stack gap={2}>
        {shortcuts.length === 0 && !adding && (
          <Text size="xs" c="dimmed">
            {t("Pin pages from their menu, or add links here.")}
          </Text>
        )}
        {shortcuts.map((s) => (
          <Group key={s.url} gap={4} wrap="nowrap" justify="space-between">
            {s.url.startsWith("/") ? (
              <Link to={s.url} style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>
                <Text size="sm" truncate>
                  {s.title}
                </Text>
              </Link>
            ) : (
              <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", color: "inherit", minWidth: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Text size="sm" truncate>
                  {s.title}
                </Text>
                <IconExternalLink size={12} />
              </a>
            )}
            <Tooltip label={t("Remove")}>
              <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => remove(s.url)} aria-label={t("Remove")}>
                <IconX size={12} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
