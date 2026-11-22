import { useEffect, useState } from "react";
import { Button, Group, Popover, Stack, Text, TextInput } from "@mantine/core";
import { IconCalendarShare, IconCheck, IconCopy } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useClipboard } from "@/hooks/use-clipboard";
import {
  CalendarFeedInfo,
  createCalendarFeed,
  getCalendarFeed,
  removeCalendarFeed,
} from "@/features/base/services/base-service";

type Props = { pageId: string; viewId: string };

// The address a calendar app is given: where this app is being used from.
export function feedUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

// Same address with the scheme calendar apps register for.
export function webcalUrl(path: string): string {
  return feedUrl(path).replace(/^https?:/, "webcal:");
}

// A private link that shows this view's rows in a calendar app.
export function CalendarSubscribe({ pageId, viewId }: Props) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const clipboard = useClipboard({ timeout: 1500 });
  const [opened, setOpened] = useState(false);
  const key = ["base-calendar-feed", pageId, viewId];
  const { data, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () => getCalendarFeed({ pageId, viewId }),
    enabled: opened,
  });
  // each time it opens: whether a calendar app has read the link since
  useEffect(() => {
    if (opened) void refetch();
  }, [opened, refetch]);
  const done = (info: CalendarFeedInfo) => queryClient.setQueryData(key, info);
  const fail = () => notifications.show({ message: t("Could not change the calendar link"), color: "red" });
  const create = useMutation({ mutationFn: () => createCalendarFeed({ pageId, viewId }), onSuccess: done, onError: fail });
  const remove = useMutation({ mutationFn: () => removeCalendarFeed({ pageId, viewId }), onSuccess: done, onError: fail });
  const busy = create.isPending || remove.isPending;
  const url = data?.path ? feedUrl(data.path) : null;
  const lastRead = data?.lastReadAt
    ? new Date(data.lastReadAt).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={380} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={<IconCalendarShare size={14} />}
          onClick={() => setOpened((o) => !o)}
          data-testid="calendar-subscribe"
        >
          {t("Subscribe")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text fw={600} size="sm">
            {t("See this view in your calendar app")}
          </Text>
          <Text size="xs" c="dimmed">
            {t(
              "A private link for Apple Calendar, Google Calendar or Outlook. It shows the rows you can see, and whoever has the link can read them.",
            )}
          </Text>
          {isLoading && (
            <Text size="xs" c="dimmed">
              {t("Loading...")}
            </Text>
          )}
          {data && !url && (
            <Button size="xs" onClick={() => create.mutate()} loading={create.isPending} data-testid="calendar-feed-create">
              {t("Create link")}
            </Button>
          )}
          {url && data?.path && (
            <>
              <TextInput
                size="xs"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={t("Calendar link")}
                data-testid="calendar-feed-url"
              />
              <Group gap="xs" grow>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  onClick={() => clipboard.copy(url)}
                >
                  {clipboard.copied ? t("Copied") : t("Copy link")}
                </Button>
                <Button size="xs" component="a" href={webcalUrl(data.path)} data-testid="calendar-feed-open">
                  {t("Open in calendar app")}
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                {lastRead
                  ? t("A calendar app last read it on {{date}}.", { date: lastRead })
                  : t("No calendar app has read it yet.")}
              </Text>
              <Group gap="xs" justify="space-between">
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => create.mutate()} disabled={busy}>
                  {t("New link")}
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => remove.mutate()}
                  disabled={busy}
                  data-testid="calendar-feed-remove"
                >
                  {t("Turn off")}
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                {t("A new link or turning it off makes the old address stop working.")}
              </Text>
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
