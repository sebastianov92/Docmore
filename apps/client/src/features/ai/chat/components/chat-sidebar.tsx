import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ActionIcon, Center, Loader, Menu, Text, TextInput, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDebouncedValue } from "@mantine/hooks";
import { IconDots, IconMessageCircle2, IconPencil, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChatsQuery, useDeleteChatMutation, useRenameChatMutation, useSearchChatsQuery } from "../queries";
import { AiChat } from "../types";
import { formatChatTime, groupChatsByAge } from "../utils/group-chats-by-age";
import classes from "./chat-sidebar.module.css";

// The left column on /ai: new chat, search, and the history by age.
export default function ChatSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { chatId } = useParams<{ chatId: string }>();
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const chatsQuery = useChatsQuery();
  const searchQuery = useSearchChatsQuery(debounced);
  const deleteChat = useDeleteChatMutation();
  const renameChat = useRenameChatMutation();
  const searching = debounced.trim().length > 0;

  const chats = useMemo(
    () => (searching ? searchQuery.data ?? [] : chatsQuery.data?.pages.flatMap((p) => p.items) ?? []),
    [searching, searchQuery.data, chatsQuery.data],
  );
  const groups = useMemo(() => groupChatsByAge(chats, t), [chats, t]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, fetchNextPage, isFetchingNextPage } = chatsQuery;
  useEffect(() => {
    if (searching || !sentinelRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
    });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [searching, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const confirmDelete = useCallback(
    (chat: AiChat) => {
      modals.openConfirmModal({
        title: t("Delete chat"),
        centered: true,
        children: (
          <Text size="sm">
            {t("Delete “{{title}}”? Its messages and files go with it.", { title: chat.title || t("Untitled chat") })}
          </Text>
        ),
        labels: { confirm: t("Delete"), cancel: t("Cancel") },
        confirmProps: { color: "red" },
        onConfirm: () =>
          deleteChat.mutate(chat.id, {
            onSuccess: () => {
              if (chatId === chat.id) navigate("/ai");
            },
          }),
      });
    },
    [deleteChat, chatId, navigate, t],
  );

  const loading = searching ? searchQuery.isLoading : chatsQuery.isLoading;

  return (
    <div className={classes.sidebar}>
      <div className={classes.header}>
        <h2 className={classes.title}>{t("AI chat")}</h2>
        <Tooltip label={t("New chat")} openDelay={250} withArrow>
          <ActionIcon component={Link} to="/ai" variant="subtle" color="gray" aria-label={t("New chat")}>
            <IconPlus size={18} />
          </ActionIcon>
        </Tooltip>
      </div>
      <TextInput
        className={classes.search}
        placeholder={t("Search chats…")}
        aria-label={t("Search chats")}
        leftSection={<IconSearch size={14} />}
        size="xs"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <div className={classes.list}>
        {loading && (
          <Center py="md">
            <Loader size="xs" />
          </Center>
        )}
        {!loading && chats.length === 0 && (
          <div className={classes.emptyList}>
            <IconMessageCircle2 size={26} stroke={1.5} />
            <div>{searching ? t("No chats match") : t("No chats yet")}</div>
          </div>
        )}
        {(searching ? [{ key: "results", label: t("Results"), chats }] : groups).map((group) => (
          <div key={group.key} className={classes.group}>
            <div className={classes.groupLabel}>{group.label}</div>
            {group.chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={chat.id === chatId}
                onDelete={() => confirmDelete(chat)}
                onRename={(title) => renameChat.mutate({ chatId: chat.id, title })}
              />
            ))}
          </div>
        ))}
        {!searching && (
          <>
            <div ref={sentinelRef} style={{ height: 1 }} />
            {isFetchingNextPage && (
              <Center py="xs">
                <Loader size="xs" />
              </Center>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  onDelete,
  onRename,
}: {
  chat: AiChat;
  active: boolean;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title ?? "");
  const title = chat.title || t("Untitled chat");

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== chat.title) onRename(next);
  };

  if (editing) {
    return (
      <div className={classes.row} data-active={active || undefined}>
        <TextInput
          size="xs"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label={t("Chat title")}
          style={{ flex: 1 }}
        />
      </div>
    );
  }

  return (
    <div className={classes.row} data-active={active || undefined}>
      <Link to={`/ai/chat/${chat.id}`} className={classes.rowLink} aria-current={active ? "page" : undefined}>
        <span className={classes.rowTitle}>{title}</span>
        <span className={classes.rowTime}>{formatChatTime(chat.updatedAt, i18n.language)}</span>
      </Link>
      <Menu position="bottom-end" shadow="md" width={160}>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm" className={classes.rowMenu} aria-label={t("Chat options")}>
            <IconDots size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={14} />}
            onClick={() => {
              setDraft(chat.title ?? "");
              setEditing(true);
            }}
          >
            {t("Rename")}
          </Menu.Item>
          <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onDelete}>
            {t("Delete")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
