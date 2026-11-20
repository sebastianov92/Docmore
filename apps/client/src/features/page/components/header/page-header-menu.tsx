import {
  ActionIcon,
  Group,
  Menu,
  Text,
  ThemeIcon,
  Tooltip,
  Select,
} from "@mantine/core";
import {
  IconArrowRight,
  IconArrowsHorizontal,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFileExport,
  IconHistory,
  IconLink,
  IconList,
  IconMarkdown,
  IconMessage,
  IconPaperclip,
  IconPresentation,
  IconPrinter,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconWifiOff,
  IconTypography,
  IconTextSize,
  IconChartBar,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { Content } from "@tiptap/react";
import { useAsideTriggerProps } from "@/hooks/use-toggle-aside.tsx";
import { useAtom, useAtomValue } from "jotai";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { useClipboard } from "@/hooks/use-clipboard";
import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { notifications } from "@mantine/notifications";
import { getAppUrl } from "@/lib/config.ts";
import { extractPageSlugId } from "@/lib";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { useDeletePageModal } from "@/features/page/hooks/use-delete-page-modal.tsx";
import { PageWidthToggle } from "@/features/user/components/page-width-pref.tsx";
import { Trans, useTranslation } from "react-i18next";
import ExportModal from "@/components/common/export-modal";
import { htmlToMarkdown } from "@docmost/editor-ext";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
  yjsSyncedAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { formattedDate } from "@/lib/time.ts";
import { PageEditModeToggle } from "@/features/user/components/page-state-pref.tsx";
import { SuggestButton } from "@/features/page-suggestion/components/suggest-button";
import { SuggestEditorModal } from "@/features/page-suggestion/components/suggest-editor-modal";
import { SuggestionsModal } from "@/features/page-suggestion/components/suggestions-modal";
import { suggestEditorOpenAtom, suggestionsModalOpenAtom } from "@/features/page-suggestion/services";
import { IconListCheck, IconPencilQuestion } from "@tabler/icons-react";
import MovePageModal from "@/features/page/components/move-page-modal.tsx";
import PageAttachmentsModal from "@/features/attachments/components/page-attachments-modal.tsx";
import PresentationModal from "@/features/editor/components/presentation/presentation-modal.tsx";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import { PageShareModal } from "@/features/page-permission/components/page-share-modal.tsx";
import {
  PageVerificationMenuItem,
  PageVerificationModal,
} from "@/features/page-verification";
import {
  useFavoriteIds,
  useAddFavoriteMutation,
  useRemoveFavoriteMutation,
} from "@/features/favorite/queries/favorite-query";
import {
  useWatchStatusQuery,
  useWatchPageMutation,
  useUnwatchPageMutation,
} from "@/features/page/queries/watcher-query";
import { useExportDisabled } from "@/features/security/hooks/use-export-disabled.ts";
import { usePrintBlockReason } from "@/features/security/hooks/use-disable-print.ts";
import { PageFontControl, PageTextSizeControl } from "@/features/user/components/reading-prefs";
import { useWorkspaceMembersQuery } from "@/features/workspace/queries/workspace-query";
import { useUpdatePageMutation } from "@/features/page/queries/page-query";
import { IPage } from "@/features/page/types/page.types";
import { PageAnalyticsModal } from "@/features/analytics/components/page-analytics-modal";

interface PageHeaderMenuProps {
  readOnly?: boolean;
}
export default function PageHeaderMenu({ readOnly }: PageHeaderMenuProps) {
  const { t } = useTranslation();
  const commentsTriggerProps = useAsideTriggerProps("comments");
  const tocTriggerProps = useAsideTriggerProps("toc");
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });
  const isDeleted = !!page?.deletedAt;

  useHotkeys(
    [
      [
        "mod+F",
        (keyboardEvent) => {
          // keepMounted modals (page import) stay in the DOM while closed
          const modalOpen = Array.from(
            document.querySelectorAll('[aria-modal="true"]'),
          ).some((modal) => modal.getClientRects().length > 0);
          if (modalOpen) return;
          keyboardEvent.preventDefault();
          const event = new CustomEvent("openFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
        { preventDefault: false },
      ],
      [
        "Escape",
        () => {
          const event = new CustomEvent("closeFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
        { preventDefault: false },
      ],
    ],
    [],
  );

  if (isDeleted) {
    return null;
  }

  return (
    <>
      <ConnectionWarning />

      {!readOnly && !page?.isBase && (
        <PageEditModeToggle size="xs" pageId={page?.id} />
      )}
      <SuggestButton page={page} readOnly={readOnly} />

      <PageShareModal readOnly={readOnly} />

      <Tooltip label={t("Comments")} openDelay={250} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          aria-label={t("Comments")}
          {...commentsTriggerProps}
        >
          <IconMessage size={20} stroke={2} />
        </ActionIcon>
      </Tooltip>

      {!page?.isBase && (
        <Tooltip label={t("Table of contents")} openDelay={250} withArrow>
          <ActionIcon
            variant="subtle"
            color="dark"
            aria-label={t("Table of contents")}
            {...tocTriggerProps}
          >
            <IconList size={20} stroke={2} />
          </ActionIcon>
        </Tooltip>
      )}

      <PageActionMenu readOnly={readOnly} />
    </>
  );
}

interface PageActionMenuProps {
  readOnly?: boolean;
}
function PageActionMenu({ readOnly }: PageActionMenuProps) {
  const { t } = useTranslation();
  const [, setHistoryModalOpen] = useAtom(historyAtoms);
  const [, setSuggestEditorOpen] = useAtom(suggestEditorOpenAtom);
  const [, setSuggestionsOpen] = useAtom(suggestionsModalOpenAtom);
  const clipboard = useClipboard({ timeout: 500 });
  const { pageSlug, spaceSlug } = useParams();
  const { data: page, isLoading } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });
  const { exportDisabled, exportDisabledLabel } = useExportDisabled(
    page?.space?.slug,
  );
  // also set by bases and synced blocks embedded from other spaces
  const printBlockReason = usePrintBlockReason();
  const { openDeleteModal } = useDeletePageModal();
  const { handleDelete } = useTreeMutation(page?.spaceId ?? "");
  const [analyticsOpened, { open: openAnalytics, close: closeAnalytics }] = useDisclosure(false);
  const [exportOpened, { open: openExportModal, close: closeExportModal }] =
    useDisclosure(false);
  const [
    movePageModalOpened,
    { open: openMovePageModal, close: closeMoveSpaceModal },
  ] = useDisclosure(false);
  const [
    verificationOpened,
    { open: openVerificationModal, close: closeVerificationModal },
  ] = useDisclosure(false);
  const [
    attachmentsOpened,
    { open: openAttachmentsModal, close: closeAttachmentsModal },
  ] = useDisclosure(false);
  const [
    presentationOpened,
    { open: openPresentationModal, close: closePresentationModal },
  ] = useDisclosure(false);
  const [pageEditor] = useAtom(pageEditorAtom);
  const pageUpdatedAt = useTimeAgo(page?.updatedAt);
  const favoriteIds = useFavoriteIds("page", page?.spaceId);
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const isFavorited = page?.id ? favoriteIds.has(page.id) : false;
  const { data: watchStatus } = useWatchStatusQuery(page?.id);
  const watchPage = useWatchPageMutation();
  const unwatchPage = useUnwatchPageMutation();

  const handleCopyLink = () => {
    const pageUrl =
      getAppUrl() + buildPageUrl(spaceSlug, page.slugId, page.title);

    clipboard.copy(pageUrl);
    notifications.show({ message: t("Link copied") });
  };

  const handleCopyAsMarkdown = () => {
    if (!pageEditor || pageEditor.isDestroyed) return;
    const html = pageEditor.getHTML();
    const markdown = htmlToMarkdown(html);
    const title = page?.title ? `# ${page.title}\n\n` : "";
    clipboard.copy(`${title}${markdown}`);
    notifications.show({ message: t("Copied") });
  };

  const handlePrint = () => {
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const openHistoryModal = () => {
    setHistoryModalOpen(true);
  };

  const handleDeletePage = () => {
    openDeleteModal({ onConfirm: () => handleDelete(page.id) });
  };

  const yjsSynced = useAtomValue(yjsSyncedAtom);
  const [presentationContent, setPresentationContent] = useState<Content>(null);

  const handleOpenPresentation = () => {
    const liveContent =
      yjsSynced && pageEditor && !pageEditor.isDestroyed
        ? pageEditor.getJSON()
        : null;
    setPresentationContent(liveContent ?? page?.content ?? null);
    openPresentationModal();
  };

  const handleToggleFavorite = () => {
    if (!page?.id) return;
    const params = { type: "page" as const, pageId: page.id };
    if (isFavorited) {
      removeFavoriteMutation.mutate(params);
    } else {
      addFavoriteMutation.mutate(params);
    }
  };

  return (
    <>
      <Menu
        shadow="xl"
        position="bottom-end"
        offset={20}
        width={230}
        withArrow
        arrowPosition="center"
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="dark"
            aria-label={t("Page actions")}
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconLink size={16} />}
            onClick={handleCopyLink}
          >
            {t("Copy link")}
          </Menu.Item>

          {!page?.isBase && (
            <Tooltip
              label={exportDisabledLabel}
              disabled={!exportDisabled}
              position="left"
              withArrow
            >
              <Menu.Item
                leftSection={<IconMarkdown size={16} />}
                onClick={exportDisabled ? undefined : handleCopyAsMarkdown}
                data-disabled={exportDisabled || undefined}
                aria-disabled={exportDisabled || undefined}
              >
                {t("Copy as Markdown")}
              </Menu.Item>
            </Tooltip>
          )}

          <Menu.Item
            leftSection={
              isFavorited ? (
                <IconStarFilled size={16} color="var(--mantine-color-yellow-5)" />
              ) : (
                <IconStar size={16} />
              )
            }
            onClick={handleToggleFavorite}
          >
            {isFavorited ? t("Remove from favorites") : t("Add to favorites")}
          </Menu.Item>

          {watchStatus?.watching ? (
            <Menu.Item
              leftSection={<IconEyeOff size={16} />}
              onClick={() => unwatchPage.mutate(page.id)}
            >
              {t("Stop watching")}
            </Menu.Item>
          ) : (
            <Menu.Item
              leftSection={<IconEye size={16} />}
              onClick={() => watchPage.mutate(page.id)}
            >
              {t("Watch page")}
            </Menu.Item>
          )}

          {!page?.isBase && <Menu.Divider />}

          {!page?.isBase && (
            <>
            {/* Plain rows, not Menu.Items: the segmented controls need the
                clicks themselves and the menu should stay open. */}
            <Group px="sm" py={6} wrap="nowrap" justify="space-between" gap="xs">
              <Group gap={8} wrap="nowrap">
                <IconTypography size={16} />
                <Text size="sm">{t("Font")}</Text>
              </Group>
              <PageFontControl />
            </Group>
            <Group px="sm" py={6} wrap="nowrap" justify="space-between" gap="xs">
              <Group gap={8} wrap="nowrap">
                <IconTextSize size={16} />
                <Text size="sm">{t("Text size")}</Text>
              </Group>
              <PageTextSizeControl />
            </Group>
            <Menu.Item leftSection={<IconArrowsHorizontal size={16} />}>
              <Group wrap="nowrap">
                <PageWidthToggle label={t("Full width")} />
              </Group>
            </Menu.Item>
            </>
          )}

          {!page?.isBase && (
            <Menu.Item
              leftSection={<IconHistory size={16} />}
              onClick={openHistoryModal}
            >
              {t("Page history")}
            </Menu.Item>
          )}

          {!page?.isBase && (
            <Menu.Item leftSection={<IconPencilQuestion size={16} />} onClick={() => setSuggestEditorOpen(true)}>
              {t("Suggest edits")}
            </Menu.Item>
          )}
          {!page?.isBase && (
            <Menu.Item leftSection={<IconListCheck size={16} />} onClick={() => setSuggestionsOpen(true)}>
              {t("Suggested edits")}
            </Menu.Item>
          )}

          {!page?.isBase && (
            <Menu.Item
              leftSection={<IconPaperclip size={16} />}
              onClick={openAttachmentsModal}
            >
              {t("Attachments")}
            </Menu.Item>
          )}

          {!page?.isBase && (
            <Menu.Item
              leftSection={<IconPresentation size={16} />}
              onClick={handleOpenPresentation}
            >
              {t("Presentation mode")}
            </Menu.Item>
          )}

          {!readOnly && !page?.isBase && (
            <PageVerificationMenuItem
              pageId={page?.id}
              onClick={openVerificationModal}
            />
          )}

          <Menu.Divider />

          {!readOnly && (
            <Menu.Item
              leftSection={<IconArrowRight size={16} />}
              onClick={openMovePageModal}
            >
              {t("Move")}
            </Menu.Item>
          )}

          <Tooltip
            label={exportDisabledLabel}
            disabled={!exportDisabled}
            position="left"
            withArrow
          >
            <Menu.Item
              leftSection={<IconFileExport size={16} />}
              onClick={exportDisabled ? undefined : openExportModal}
              data-disabled={exportDisabled || undefined}
              aria-disabled={exportDisabled || undefined}
            >
              {t("Export")}
            </Menu.Item>
          </Tooltip>
          <Menu.Item leftSection={<IconChartBar size={16} />} onClick={openAnalytics} data-testid="page-analytics-item">
            {t("Analytics")}
          </Menu.Item>

          <Tooltip
            label={printBlockReason}
            disabled={!printBlockReason}
            position="left"
            withArrow
          >
            <Menu.Item
              leftSection={<IconPrinter size={16} />}
              onClick={printBlockReason ? undefined : handlePrint}
              data-disabled={printBlockReason ? true : undefined}
              aria-disabled={printBlockReason ? true : undefined}
            >
              {t("Print PDF")}
            </Menu.Item>
          </Tooltip>

          {!readOnly && (
            <>
              <Menu.Divider />
              <Menu.Item
                color={"red"}
                leftSection={<IconTrash size={16} />}
                onClick={handleDeletePage}
              >
                {t("Move to trash")}
              </Menu.Item>
            </>
          )}

          <Menu.Divider />

          <>
            <Group px="sm" wrap="nowrap" style={{ cursor: "pointer" }}>
              <Tooltip
                label={t("Edited by {{name}} {{time}}", {
                  name: page.lastUpdatedBy.name,
                  time: pageUpdatedAt,
                })}
                position="left-start"
              >
                <div style={{ width: 210 }}>
                  <Text size="xs" c="dimmed" truncate="end">
                    {t("Word count: {{wordCount}}", {
                      wordCount: pageEditor?.storage?.characterCount?.words(),
                    })}
                  </Text>

                  <Text size="xs" c="dimmed" lineClamp={1}>
                    <Trans
                      defaults="Created by: <b>{{creatorName}}</b>"
                      values={{ creatorName: page?.creator?.name }}
                      components={{ b: <Text span fw={500} /> }}
                    />
                  </Text>
                  <PageOwnerRow page={page} readOnly={readOnly} />
                  <Text size="xs" c="dimmed" truncate="end">
                    {t("Created at: {{time}}", {
                      time: formattedDate(page.createdAt),
                    })}
                  </Text>
                </div>
              </Tooltip>
            </Group>
          </>
        </Menu.Dropdown>
      </Menu>

      <PageAnalyticsModal pageId={page.id} opened={analyticsOpened} onClose={closeAnalytics} />

      <ExportModal
        type="page"
        id={page.id}
        open={exportOpened}
        onClose={closeExportModal}
      />

      <MovePageModal
        pageId={page.id}
        slugId={page.slugId}
        currentSpaceSlug={spaceSlug}
        onClose={closeMoveSpaceModal}
        open={movePageModalOpened}
      />

      <PageVerificationModal
        pageId={page.id}
        opened={verificationOpened}
        onClose={closeVerificationModal}
      />

      <PageAttachmentsModal
        pageId={page.id}
        readOnly={readOnly}
        open={attachmentsOpened}
        onClose={closeAttachmentsModal}
      />

      <PresentationModal
        pageId={page.id}
        title={page.title}
        content={presentationContent}
        opened={presentationOpened}
        onClose={closePresentationModal}
      />
      <SuggestEditorModal page={page} />
      <SuggestionsModal page={page} />
    </>
  );
}

function ConnectionWarning() {
  const { t } = useTranslation();
  const yjsConnectionStatus = useAtomValue(yjsConnectionStatusAtom);
  const [showWarning, setShowWarning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isDisconnected = ["disconnected", "connecting"].includes(
      yjsConnectionStatus,
    );

    if (isDisconnected) {
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => setShowWarning(true), 5000);
      }
    } else {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setShowWarning(false);
    }
  }, [yjsConnectionStatus]);

  // Cleanup only on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  if (!showWarning) return null;

  return (
    <Tooltip
      label={t("Real-time editor connection lost. Retrying...")}
      openDelay={250}
      withArrow
    >
      <ThemeIcon
        variant="default"
        c="red"
        role="status"
        aria-label={t("Real-time editor connection lost. Retrying...")}
        style={{ border: "none" }}
      >
        <IconWifiOff size={20} stroke={2} />
      </ThemeIcon>
    </Tooltip>
  );
}

// Owner of the page: shown to everyone, editable by anyone who can edit
// the page. Null means no owner.
function PageOwnerRow({ page, readOnly }: { page: IPage; readOnly?: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const { data: members } = useWorkspaceMembersQuery({ limit: 50, query: search } as any);
  const updatePageMutation = useUpdatePageMutation();
  const data = (members?.items ?? []).map((u) => ({ value: u.id, label: u.name || u.email }));
  if (page.owner && !data.some((d) => d.value === page.owner!.id)) {
    data.unshift({ value: page.owner.id, label: page.owner.name });
  }
  const save = (ownerId: string | null) => {
    updatePageMutation.mutate({ pageId: page.id, ownerId } as any);
    setEditing(false);
  };
  if (editing) {
    return (
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Select
          size="xs"
          mt={4}
          data={data}
          value={page.ownerId ?? null}
          searchable
          clearable
          searchValue={search}
          onSearchChange={setSearch}
          placeholder={t("Pick an owner")}
          onChange={(v) => save(v)}
          onBlur={() => setEditing(false)}
          nothingFoundMessage={t("No members found")}
          comboboxProps={{ withinPortal: true }}
          autoFocus
          aria-label={t("Owner")}
        />
      </div>
    );
  }
  return (
    <Text
      size="xs"
      c="dimmed"
      lineClamp={1}
      onClick={(e) => {
        if (readOnly) return;
        e.stopPropagation();
        setEditing(true);
      }}
      style={{ cursor: readOnly ? "default" : "pointer" }}
      data-testid="page-owner"
    >
      {t("Owner")}: {" "}
      <Text span fw={500}>
        {page.owner?.name ?? t("None")}
      </Text>
    </Text>
  );
}
