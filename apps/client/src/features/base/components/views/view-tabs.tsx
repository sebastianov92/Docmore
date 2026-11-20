import { useState, useCallback, useEffect, useRef } from "react";
import {
  Group,
  UnstyledButton,
  Text,
  ActionIcon,
  Tooltip,
  TextInput,
  Popover,
  Stack,
  Divider,
  Menu,
} from "@mantine/core";
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconTable,
  IconLayoutKanban,
  IconCalendar,
  IconLayoutList,
  IconLayoutGrid,
  IconRss,
  IconTimeline,
  IconChartBar,
  IconLink,
} from "@tabler/icons-react";
import { BaseViewType } from "@/features/base/types/base.types";

export const VIEW_ICONS: Record<BaseViewType, typeof IconTable> = {
  table: IconTable,
  kanban: IconLayoutKanban,
  calendar: IconCalendar,
  list: IconLayoutList,
  gallery: IconLayoutGrid,
  feed: IconRss,
  timeline: IconTimeline,
  chart: IconChartBar,
};
import { IBaseView } from "@/features/base/types/base.types";
import {
  useUpdateViewMutation,
  useDeleteViewMutation,
} from "@/features/base/queries/base-view-query";
import { useTranslation } from "react-i18next";
import cellClasses from "@/features/base/styles/cells.module.css";
import { usePageQuery } from "@/features/page/queries/page-query";
import { useClipboard } from "@/hooks/use-clipboard";
import { getAppUrl } from "@/lib/config.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { notifications } from "@mantine/notifications";

type ViewTabsProps = {
  views: IBaseView[];
  activeViewId: string | undefined;
  pageId: string;
  onViewChange: (viewId: string) => void;
  onAddView?: (type?: BaseViewType) => void;
};

export function ViewTabs({
  views,
  activeViewId,
  pageId,
  onViewChange,
  onAddView,
}: ViewTabsProps) {
  const { t } = useTranslation();
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const updateViewMutation = useUpdateViewMutation();
  const deleteViewMutation = useDeleteViewMutation();

  const handleRenameStart = useCallback(
    (view: IBaseView) => {
      setEditingViewId(view.id);
      setEditingName(view.name);
    },
    [],
  );

  const handleRenameCommit = useCallback(() => {
    if (!editingViewId) return;
    const trimmed = editingName.trim();
    const view = views.find((v) => v.id === editingViewId);
    if (trimmed && view && trimmed !== view.name) {
      updateViewMutation.mutate({
        viewId: editingViewId,
        pageId,
        name: trimmed,
      });
    }
    setEditingViewId(null);
  }, [editingViewId, editingName, views, pageId, updateViewMutation]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameCommit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEditingViewId(null);
      }
    },
    [handleRenameCommit],
  );

  // Link that opens the base on this view; pasted into a page it embeds
  // the view (dashboards are pages of such embeds).
  const { data: viewPage } = usePageQuery({ pageId });
  const clipboard = useClipboard({ timeout: 500 });
  const handleCopyLink = useCallback(
    (viewId: string) => {
      if (!viewPage) return;
      clipboard.copy(
        getAppUrl() + buildPageUrl(viewPage.space?.slug, viewPage.slugId, viewPage.title) + `?view=${viewId}`,
      );
      notifications.show({ message: t("Link copied") });
    },
    [viewPage, clipboard, t],
  );

  const handleDelete = useCallback(
    (viewId: string) => {
      if (views.length <= 1) return;
      deleteViewMutation.mutate({ viewId, pageId });
      if (viewId === activeViewId && views.length > 1) {
        const remaining = views.filter((v) => v.id !== viewId);
        onViewChange(remaining[0].id);
      }
    },
    [views, pageId, activeViewId, deleteViewMutation, onViewChange],
  );

  return (
    <Group gap={4}>
      {views.map((view) => (
        <ViewTab
          key={view.id}
          view={view}
          isActive={view.id === activeViewId}
          isEditing={view.id === editingViewId}
          editingName={editingName}
          canDelete={views.length > 1}
          onClick={() => onViewChange(view.id)}
          onRenameStart={() => handleRenameStart(view)}
          onRenameChange={setEditingName}
          onRenameCommit={handleRenameCommit}
          onRenameKeyDown={handleRenameKeyDown}
          onDelete={() => handleDelete(view.id)}
          onCopyLink={() => handleCopyLink(view.id)}
        />
      ))}
      {onAddView && (
        <Menu position="bottom-start" withinPortal shadow="md" width={180}>
          <Menu.Target>
            <Tooltip label={t("Add view")}>
              <ActionIcon variant="subtle" size="sm" color="gray" aria-label={t("Add view")}>
                <IconPlus size={14} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconTable size={14} />} onClick={() => onAddView("table")}>
              {t("Table")}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutKanban size={14} />} onClick={() => onAddView("kanban")}>
              {t("Kanban")}
            </Menu.Item>
            <Menu.Item leftSection={<IconCalendar size={14} />} onClick={() => onAddView("calendar")}>
              {t("Calendar")}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutList size={14} />} onClick={() => onAddView("list")}>
              {t("List")}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutGrid size={14} />} onClick={() => onAddView("gallery")}>
              {t("Gallery")}
            </Menu.Item>
            <Menu.Item leftSection={<IconRss size={14} />} onClick={() => onAddView("feed")}>
              {t("Feed")}
            </Menu.Item>
            <Menu.Item leftSection={<IconTimeline size={14} />} onClick={() => onAddView("timeline")}>
              {t("Timeline")}
            </Menu.Item>
            <Menu.Item leftSection={<IconChartBar size={14} />} onClick={() => onAddView("chart")}>
              {t("Chart")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}

function ViewTab({
  view,
  isActive,
  isEditing,
  editingName,
  canDelete,
  onClick,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameKeyDown,
  onDelete,
  onCopyLink,
}: {
  view: IBaseView;
  isActive: boolean;
  isEditing: boolean;
  editingName: string;
  canDelete: boolean;
  onClick: () => void;
  onRenameStart: () => void;
  onRenameChange: (name: string) => void;
  onRenameCommit: () => void;
  onRenameKeyDown: (e: React.KeyboardEvent) => void;
  onDelete: () => void;
  onCopyLink: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpened, setMenuOpened] = useState(false);
  const targetRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Mantine Popover's built-in closeOnClickOutside / closeOnEscape
  // only fire when focus is inside the dropdown — but the menu opens
  // via right-click (focus stays on body), so neither ever triggers.
  // Wire the close paths ourselves while the menu is open. Capture
  // phase mousedown so we run before grid-container's outside-click
  // logic (which would otherwise blur the focused element first and
  // cause weirdness).
  useEffect(() => {
    if (!menuOpened) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      if (targetRef.current?.contains(target)) return;
      setMenuOpened(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpened(false);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpened]);

  if (isEditing) {
    return (
      <TextInput
        size="xs"
        w={120}
        value={editingName}
        onChange={(e) => onRenameChange(e.currentTarget.value)}
        onBlur={onRenameCommit}
        onKeyDown={onRenameKeyDown}
        autoFocus
      />
    );
  }

  const handleTabClick = useCallback(() => {
    // Left-click on the tab is "switch view"; if the menu happens to
    // be open from a prior right-click, dismiss it as part of the
    // same gesture so the user doesn't have to click twice.
    if (menuOpened) setMenuOpened(false);
    onClick();
  }, [menuOpened, onClick]);

  return (
    <Popover
      opened={menuOpened}
      onClose={() => setMenuOpened(false)}
      position="bottom-start"
      shadow="md"
      width={180}
      withinPortal
    >
      <Popover.Target>
        <UnstyledButton
          ref={targetRef}
          onClick={handleTabClick}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpened(true);
          }}
          style={{
            padding: "4px 10px",
            borderRadius: "var(--mantine-radius-sm)",
            fontWeight: isActive ? 600 : 400,
          }}
        >
          <Group gap={6} wrap="nowrap">
            <TabIcon type={view.type} />
            <Text
              size="sm"
              c={isActive ? undefined : "dimmed"}
            >
              {view.name}
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown ref={dropdownRef} p={4}>
        <Stack gap={0}>
          <UnstyledButton
            className={cellClasses.menuItem}
            onClick={() => {
              setMenuOpened(false);
              onCopyLink();
            }}
          >
            <Group gap={8} wrap="nowrap">
              <IconLink size={14} />
              <Text size="sm">{t("Copy link to view")}</Text>
            </Group>
          </UnstyledButton>
          <UnstyledButton
            className={cellClasses.menuItem}
            onClick={() => {
              setMenuOpened(false);
              onRenameStart();
            }}
          >
            <Group gap={8} wrap="nowrap">
              <IconPencil size={14} />
              <Text size="sm">{t("Rename")}</Text>
            </Group>
          </UnstyledButton>
          {canDelete && (
            <>
              <Divider my={4} />
              <UnstyledButton
                className={cellClasses.menuItem}
                onClick={() => {
                  setMenuOpened(false);
                  onDelete();
                }}
                style={{ color: "var(--mantine-color-red-6)" }}
              >
                <Group gap={8} wrap="nowrap">
                  <IconTrash size={14} />
                  <Text size="sm">{t("Delete view")}</Text>
                </Group>
              </UnstyledButton>
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function TabIcon({ type }: { type: BaseViewType }) {
  const Icon = VIEW_ICONS[type] ?? IconTable;
  return <Icon size={14} opacity={0.5} />;
}
