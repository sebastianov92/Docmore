import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconCloudDown,
  IconFileDescription,
  IconFolder,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { setWorkOffline, useConnectivity } from "@/lib/offline/connectivity.ts";
import { offlineUsage, syncNow, useOfflineStatus, wipeOfflineData } from "@/lib/offline/engine.ts";
import { filesUsage } from "@/lib/offline/files.ts";
import { Conflict, OutboxOp, listConflicts, listOutbox } from "@/lib/offline/outbox.ts";
import {
  Pin,
  getOfflineSettings,
  getPins,
  setOfflineSettings,
  setPinned,
  usePinsVersion,
} from "@/lib/offline/pins.ts";
import { getPageInfo, getSpace } from "@/lib/offline/recorder.ts";
import { discardConflict, restoreAndSend, retryConflict, saveAsNewPage } from "@/lib/offline/resolve.ts";
import { treeGet } from "@/lib/offline/tree-store.ts";

type NamedPin = Pin & { name: string };

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function OfflineSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const connectivity = useConnectivity();
  const status = useOfflineStatus();
  const pinsVersion = usePinsVersion();
  const [pins, setPins] = useState<NamedPin[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [queue, setQueue] = useState<OutboxOp[]>([]);
  const [usage, setUsage] = useState<{ pages: number; bytes: number | null; files: number }>({
    pages: 0,
    bytes: null,
    files: 0,
  });
  const [settings, setSettings] = useState(getOfflineSettings());
  const [busy, setBusy] = useState<string | null>(null);

  const kindLabel = useCallback(
    (kind: string): string => {
      const labels: Record<string, string> = {
        "page.create": t("New page"),
        "page.rename": t("Rename page"),
        "page.update": t("Page details"),
        "page.move": t("Move page"),
        "page.trash": t("Move page to trash"),
        "comment.create": t("Comment"),
        "comment.resolve": t("Resolve comment"),
        "comment.update": t("Edit comment"),
        "comment.delete": t("Delete comment"),
        "favorite.add": t("Add to favorites"),
        "favorite.remove": t("Remove from favorites"),
        "row.create": t("New row"),
        "row.update": t("Edit row"),
        "row.delete": t("Delete row"),
        "file.upload": t("Upload file"),
        "doc.deleted": t("Edited here, moved to trash on the server"),
        "doc.read_only": t("Edited here, but you can no longer edit this page"),
        "doc.forbidden": t("Edited here, but you no longer have access to this page"),
        "doc.missing": t("Edited here, but the page no longer exists"),
        "doc.invalid": t("The edits to this page could not be sent"),
        "doc.too_large": t("Too large to send in the background. Open the page to send it."),
      };
      return labels[kind] ?? kind;
    },
    [t],
  );

  const reload = useCallback(async () => {
    const named: NamedPin[] = [];
    for (const pin of getPins()) {
      let name = "";
      if (pin.type === "space") name = (await getSpace(pin.id))?.name ?? "";
      else name = (await treeGet(pin.id))?.title ?? (await getPageInfo(pin.id))?.title ?? "";
      named.push({ ...pin, name: name || t("Untitled") });
    }
    setPins(named);
    setConflicts(await listConflicts().catch(() => []));
    setQueue(await listOutbox().catch(() => []));
    const [overall, files] = await Promise.all([offlineUsage(), filesUsage().catch(() => ({ bytes: 0, count: 0 }))]);
    setUsage({ pages: overall.pages, bytes: overall.bytes, files: files.count });
    setSettings(getOfflineSettings());
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload, pinsVersion, status.pending, status.conflicts, status.lastSyncAt, status.ready]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch (error: any) {
      notifications.show({ color: "red", message: error?.message ?? t("That did not work") });
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const openPage = async (pageId: string | undefined) => {
    if (!pageId) return;
    const info = (await getPageInfo(pageId)) ?? (await treeGet(pageId));
    if (!info) return;
    const space = await getSpace((info as any).spaceId);
    if (space?.slug) navigate(buildPageUrl(space.slug, info.slugId, (info as any).title));
  };

  const confirmWipe = () =>
    modals.openConfirmModal({
      title: t("Remove offline data from this device"),
      children: (
        <Text size="sm">
          {status.pending > 0
            ? t(
                "{{count}} changes made offline were not sent yet and will be lost. Downloaded pages and files are removed too.",
                { count: status.pending },
              )
            : t("Downloaded pages and files are removed. Your pages stay on the server.")}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        await wipeOfflineData();
        window.location.reload();
      },
    });

  if (!status.ready) {
    return (
      <>
        <DocumentTitle title={t("Offline")} />
        <SettingsTitle title={t("Offline")} />
        <Text size="sm" c="dimmed">
          {t("This browser does not allow saving data for offline use (private window or storage blocked).")}
        </Text>
      </>
    );
  }

  return (
    <>
      <DocumentTitle title={t("Offline")} />
      <SettingsTitle title={t("Offline")} />

      <Stack gap="xl">
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Group gap="xs">
                <Text fw={600}>{connectivity.online ? t("Connected") : t("Offline")}</Text>
                {status.pending > 0 && (
                  <Badge variant="light" color="blue">
                    {t("{{count}} to send", { count: status.pending })}
                  </Badge>
                )}
                {status.conflicts > 0 && (
                  <Badge variant="light" color="red">
                    {t("{{count}} to review", { count: status.conflicts })}
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed" mt={4}>
                {status.lastSyncAt
                  ? t("Last synced {{time}}", { time: new Date(status.lastSyncAt).toLocaleString() })
                  : t("Not synced yet")}
              </Text>
              {status.lastError && (
                <Text size="sm" c="red" mt={4}>
                  {status.lastError}
                </Text>
              )}
            </div>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconRefresh size={14} />}
              loading={status.syncing}
              disabled={!connectivity.online}
              onClick={() => void syncNow()}
            >
              {t("Sync now")}
            </Button>
          </Group>
          <Divider my="md" />
          <Switch
            checked={connectivity.workOffline}
            onChange={(event) => setWorkOffline(event.currentTarget.checked)}
            label={t("Work offline")}
            description={t("Stop talking to the server until you turn this off. Changes are kept here and sent later.")}
          />
        </Paper>

        {conflicts.length > 0 && (
          <div>
            <Title order={5} mb="xs">
              {t("Needs your decision")}
            </Title>
            <Stack gap="xs">
              {conflicts.map((conflict) => (
                <Paper key={conflict.id} withBorder p="sm" radius="md" data-testid="offline-conflict">
                  <Text size="sm" fw={600}>
                    {conflict.title || t("Untitled")}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {kindLabel(conflict.kind)}
                    {conflict.type === "op" && conflict.reason ? ` · ${conflict.reason}` : ""}
                  </Text>
                  <Group gap="xs" mt="xs">
                    {conflict.kind === "doc.deleted" && (
                      <Button
                        size="xs"
                        loading={busy === `${conflict.id}:restore`}
                        onClick={() => act(`${conflict.id}:restore`, () => restoreAndSend(conflict))}
                      >
                        {t("Restore the page and send my edits")}
                      </Button>
                    )}
                    {conflict.type === "doc" && conflict.kind !== "doc.too_large" && (
                      <Button
                        size="xs"
                        variant="default"
                        loading={busy === `${conflict.id}:copy`}
                        onClick={() =>
                          act(`${conflict.id}:copy`, async () => {
                            const page = await saveAsNewPage(conflict, t("(offline copy)"));
                            if (page) notifications.show({ message: t("Saved as a new page") });
                          })
                        }
                      >
                        {t("Keep as a new page")}
                      </Button>
                    )}
                    {conflict.kind === "doc.too_large" && (
                      <Button size="xs" onClick={() => void openPage(conflict.pageId)}>
                        {t("Open the page")}
                      </Button>
                    )}
                    {conflict.type === "op" && (
                      <Button
                        size="xs"
                        variant="default"
                        loading={busy === `${conflict.id}:retry`}
                        onClick={() => act(`${conflict.id}:retry`, () => retryConflict(conflict))}
                      >
                        {t("Try again")}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      loading={busy === `${conflict.id}:discard`}
                      onClick={() => act(`${conflict.id}:discard`, () => discardConflict(conflict))}
                    >
                      {t("Discard my change")}
                    </Button>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </div>
        )}

        {queue.length > 0 && (
          <div>
            <Title order={5} mb="xs">
              {t("Waiting to be sent")}
            </Title>
            <Paper withBorder radius="md">
              {queue.map((op, index) => (
                <Group
                  key={op.id}
                  justify="space-between"
                  wrap="nowrap"
                  px="sm"
                  py={8}
                  style={index > 0 ? { borderTop: "1px solid var(--mantine-color-default-border)" } : undefined}
                >
                  <Text size="sm" truncate>
                    {kindLabel(op.kind)}
                    {op.title ? ` · ${op.title}` : ""}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {new Date(op.createdAt).toLocaleTimeString()}
                  </Text>
                </Group>
              ))}
            </Paper>
          </div>
        )}

        <div>
          <Title order={5} mb={4}>
            {t("Kept on this device")}
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            {t(
              "Choose Available offline in the menu of a page or a space. A page brings everything under it.",
            )}
          </Text>
          {pins.length === 0 ? (
            <Paper withBorder p="md" radius="md">
              <Group gap="sm" wrap="nowrap">
                <IconCloudDown size={20} stroke={1.5} />
                <Text size="sm" c="dimmed">
                  {t("Nothing chosen yet.")}
                </Text>
              </Group>
            </Paper>
          ) : (
            <Paper withBorder radius="md">
              {pins.map((pin, index) => (
                <Group
                  key={`${pin.type}:${pin.id}`}
                  justify="space-between"
                  wrap="nowrap"
                  px="sm"
                  py={6}
                  style={index > 0 ? { borderTop: "1px solid var(--mantine-color-default-border)" } : undefined}
                >
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    {pin.type === "space" ? <IconFolder size={16} /> : <IconFileDescription size={16} />}
                    <Text size="sm" truncate>
                      {pin.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {pin.type === "space" ? t("Space") : t("Page")}
                    </Text>
                  </Group>
                  <Tooltip label={t("Stop keeping it here")} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t("Stop keeping it here")}
                      onClick={() =>
                        act(`${pin.id}:unpin`, async () => {
                          await setPinned(pin.type, pin.id, false);
                          void syncNow();
                        })
                      }
                    >
                      <IconX size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Paper>
          )}
        </div>

        <div>
          <Title order={5} mb="sm">
            {t("Also keep")}
          </Title>
          <Stack gap="md">
            <Switch
              checked={settings.keepRecent}
              onChange={(event) =>
                act("recent", () => setOfflineSettings({ keepRecent: event.currentTarget.checked }).then(() => syncNow()))
              }
              label={t("Pages I opened lately")}
              description={t("The most recent pages stay on this device without marking them.")}
            />
            {settings.keepRecent && (
              <Group gap="sm">
                <Text size="sm">{t("How many")}</Text>
                <SegmentedControl
                  size="xs"
                  value={String(settings.recentCount)}
                  onChange={(value) =>
                    act("count", () => setOfflineSettings({ recentCount: Number(value) }).then(() => syncNow()))
                  }
                  data={["20", "50", "100", "200"]}
                />
              </Group>
            )}
            <Switch
              checked={settings.includeVideos}
              onChange={(event) =>
                act("videos", () => setOfflineSettings({ includeVideos: event.currentTarget.checked }))
              }
              label={t("Videos in pages")}
              description={t("Off by default: videos take the most space.")}
            />
          </Stack>
        </div>

        <div>
          <Title order={5} mb={4}>
            {t("Space used")}
          </Title>
          <Text size="sm" c="dimmed">
            {t("{{pages}} pages and {{files}} files on this device", { pages: usage.pages, files: usage.files })}
            {usage.bytes !== null ? ` · ${formatBytes(usage.bytes)}` : ""}
          </Text>
          <Button
            mt="sm"
            variant="default"
            color="red"
            size="xs"
            leftSection={<IconTrash size={14} />}
            onClick={confirmWipe}
          >
            {t("Remove offline data from this device")}
          </Button>
        </div>
      </Stack>
    </>
  );
}
