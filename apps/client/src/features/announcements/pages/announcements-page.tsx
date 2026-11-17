import { useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArchive, IconArchiveOff, IconDots, IconPencil, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  useAnnouncementsQuery,
  useArchiveAnnouncementMutation,
  useDeleteAnnouncementMutation,
  useUnarchiveAnnouncementMutation,
} from "../queries";
import { ANNOUNCEMENT_COLOR_STYLES, ANNOUNCEMENT_TYPE_LABELS, Announcement, AnnouncementListStatus } from "../types";
import { formatAnnouncementTime, getAnnouncementPreview } from "../utils";
import { AnnouncementFormModal } from "../components/announcement-form-modal";

const STATUS_COLORS: Record<Announcement["status"], string> = {
  active: "green",
  scheduled: "blue",
  ended: "gray",
  archived: "gray",
};

// Settings > Announcements: the list with its state, and the form.
export default function AnnouncementsPage() {
  const { t, i18n } = useTranslation();
  const { isAdmin } = useUserRole();
  const [status, setStatus] = useState<AnnouncementListStatus>("active");
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<Announcement[][]>([]);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const params = useMemo(
    () => ({ status, query: debounced.trim() || undefined, limit: 25, cursor }),
    [status, debounced, cursor],
  );
  const query = useAnnouncementsQuery(params, isAdmin);
  const archive = useArchiveAnnouncementMutation();
  const unarchive = useUnarchiveAnnouncementMutation();
  const remove = useDeleteAnnouncementMutation();

  if (!isAdmin) return null;

  // Earlier pages stay while a "load more" fetches the next cursor.
  const items = [...pages.flat(), ...(query.data?.items ?? [])].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
  const resetPaging = () => {
    setPages([]);
    setCursor(undefined);
  };

  const confirmDelete = (a: Announcement) =>
    modals.openConfirmModal({
      title: t("Delete announcement"),
      centered: true,
      children: <Text size="sm">{t("“{{title}}” will be deleted for good.", { title: a.title })}</Text>,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(a.id),
    });

  return (
    <>
      <DocumentTitle title={t("Announcements")} />
      <SettingsTitle title={t("Announcements")} />
      <Text size="sm" c="dimmed" mb="md">
        {t("A banner over the app for members, or over the public pages too. One shows at a time.")}
      </Text>

      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap="sm">
          <SegmentedControl
            size="xs"
            value={status}
            onChange={(value) => {
              setStatus(value as AnnouncementListStatus);
              resetPaging();
            }}
            data={[
              { value: "active", label: t("Current") },
              { value: "archived", label: t("Archived") },
              { value: "all", label: t("All") },
            ]}
          />
          <TextInput
            size="xs"
            placeholder={t("Search…")}
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              resetPaging();
            }}
            aria-label={t("Search announcements")}
          />
        </Group>
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          {t("New announcement")}
        </Button>
      </Group>

      {query.isError && (
        <Text c="red" size="sm">
          {getApiErrorMessage(query.error, t("Could not load the announcements"))}
        </Text>
      )}
      {query.isLoading && (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      )}
      {!query.isLoading && items.length === 0 && (
        <Text size="sm" c="dimmed" py="lg" ta="center">
          {search ? t("Nothing matches.") : status === "archived" ? t("No archived announcements.") : t("No announcements yet.")}
        </Text>
      )}

      {items.length > 0 && (
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Announcement")}</Table.Th>
              <Table.Th>{t("Audience")}</Table.Th>
              <Table.Th>{t("Schedule")}</Table.Th>
              <Table.Th>{t("Status")}</Table.Th>
              <Table.Th aria-label={t("Actions")} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((a) => {
              const colors = ANNOUNCEMENT_COLOR_STYLES[a.color] ?? ANNOUNCEMENT_COLOR_STYLES.gray;
              return (
                <Table.Tr key={a.id} style={{ cursor: "pointer" }} onClick={() => {
                  setEditing(a);
                  setFormOpen(true);
                }}>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <span
                        aria-hidden
                        style={{ width: 10, height: 10, borderRadius: 5, background: colors.background, flexShrink: 0 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" fw={500} lineClamp={1}>
                          {a.title}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {t(ANNOUNCEMENT_TYPE_LABELS[a.type])} · {getAnnouncementPreview(a.content)}
                        </Text>
                      </div>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{a.audience === "everyone" ? t("Everyone") : t("Members")}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{formatAnnouncementTime(a.startsAt, i18n.language)}</Text>
                    <Text size="xs" c="dimmed">
                      {a.endsAt ? t("until {{time}}", { time: formatAnnouncementTime(a.endsAt, i18n.language) }) : t("no end")}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={STATUS_COLORS[a.status]}>
                      {t(a.status === "active" ? "Live" : a.status === "scheduled" ? "Scheduled" : a.status === "ended" ? "Ended" : "Archived")}
                    </Badge>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    <Menu position="bottom-end" shadow="md" width={180}>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray" aria-label={t("Actions for {{name}}", { name: a.title })}>
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconPencil size={14} />}
                          onClick={() => {
                            setEditing(a);
                            setFormOpen(true);
                          }}
                        >
                          {t("Edit")}
                        </Menu.Item>
                        {a.status === "archived" ? (
                          <Menu.Item leftSection={<IconArchiveOff size={14} />} onClick={() => unarchive.mutate(a.id)}>
                            {t("Restore")}
                          </Menu.Item>
                        ) : (
                          <Menu.Item leftSection={<IconArchive size={14} />} onClick={() => archive.mutate(a.id)}>
                            {t("Archive")}
                          </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => confirmDelete(a)}>
                          {t("Delete")}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}

      {query.data?.meta?.hasNextPage && (
        <Center mt="md">
          <Button
            variant="default"
            size="xs"
            loading={query.isFetching}
            onClick={() => {
              setPages((prev) => [...prev, query.data!.items]);
              setCursor(query.data!.meta.nextCursor);
            }}
          >
            {t("Load more")}
          </Button>
        </Center>
      )}

      <AnnouncementFormModal opened={formOpen} onClose={() => setFormOpen(false)} announcement={editing} />
    </>
  );
}
