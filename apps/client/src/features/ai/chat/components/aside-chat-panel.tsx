import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Loader, Popover, ScrollArea, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconArrowsDiagonal,
  IconChevronDown,
  IconFileText,
  IconLanguage,
  IconListDetails,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";
import { useChatInfoQuery, useChatsQuery, useSearchChatsQuery } from "../queries";
import { useChatStream } from "../hooks/use-chat-stream";
import { ChatThread } from "./chat-thread";
import ChatInput from "./chat-input";
import { ChatAttachment, PageMention, SendExtras } from "../types";
import classes from "./aside-chat.module.css";

// The chat beside a page. The open page rides along as context for the
// first message; the chat can be switched from the history or opened full.
export default function AsideChatPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [, setAside] = useAtom(asideStateAtom);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextPages, setContextPages] = useState<PageMention[]>([]);
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const { data: page } = usePageQuery({ pageId: slugId });
  const info = useChatInfoQuery(chatId);
  const chat = useChatStream(chatId, { onChatCreated: setChatId });

  useEffect(() => {
    if (page && !chatId) setContextPages([{ id: page.id, title: page.title || "", slugId: page.slugId }]);
  }, [page, chatId]);

  useEffect(() => {
    if (info.data?.messages) chat.hydrate(info.data.messages);
  }, [info.data, chat.hydrate]);

  useEffect(() => {
    if (chatId && info.isError) setChatId(undefined);
  }, [chatId, info.isError]);

  const startNew = useCallback(() => {
    setChatId(undefined);
    if (page) setContextPages([{ id: page.id, title: page.title || "", slugId: page.slugId }]);
  }, [page]);

  const close = useCallback(() => setAside({ tab: "", isAsideOpen: false }), [setAside]);
  const expand = useCallback(() => {
    navigate(chatId ? `/ai/chat/${chatId}` : "/ai");
    close();
  }, [chatId, navigate, close]);

  const send = useCallback(
    (content: string, mentions: PageMention[], attachments: ChatAttachment[], extras?: SendExtras) =>
      chat.send(content, mentions, attachments, contextPages[0]?.id, extras),
    [chat.send, contextPages],
  );

  const started = chat.messages.length > 0 || chat.isStreaming;
  const quick = [
    { icon: IconFileText, label: t("Summarize this page"), prompt: "Summarize this page." },
    { icon: IconListDetails, label: t("List the key points"), prompt: "List the key points of this page." },
    { icon: IconLanguage, label: t("Translate this page"), prompt: "Translate this page into English." },
  ];

  return (
    <div className={classes.panel}>
      <div className={classes.toolbar}>
        <Popover opened={historyOpen} onChange={setHistoryOpen} position="bottom-start" width={280} shadow="md">
          <Popover.Target>
            <UnstyledButton className={classes.titleButton} onClick={() => setHistoryOpen((o) => !o)}>
              <span className={classes.titleText}>{info.data?.chat?.title || t("New chat")}</span>
              <IconChevronDown size={16} stroke={1.75} />
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown>
            <History
              activeChatId={chatId}
              onSelect={(id) => {
                setChatId(id);
                setHistoryOpen(false);
              }}
            />
          </Popover.Dropdown>
        </Popover>
        <div className={classes.spacer} />
        <Tooltip label={t("New chat")} openDelay={250}>
          <ActionIcon variant="subtle" color="gray" onClick={startNew} aria-label={t("New chat")}>
            <IconPlus size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Open full page")} openDelay={250}>
          <ActionIcon variant="subtle" color="gray" onClick={expand} aria-label={t("Open full page")}>
            <IconArrowsDiagonal size={17} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Close")} openDelay={250}>
          <ActionIcon variant="subtle" color="gray" onClick={close} aria-label={t("Close")}>
            <IconX size={18} />
          </ActionIcon>
        </Tooltip>
      </div>

      {chat.error && <div className={classes.error}>{chat.error}</div>}

      {started ? (
        <div className={classes.messages}>
          <ChatThread
            messages={chat.messages}
            isStreaming={chat.isStreaming}
            streamingContent={chat.streamingContent}
            streamingToolCalls={chat.streamingToolCalls}
          onDecide={chat.decide}
          onResearchDone={chat.refresh}
            compact
          />
        </div>
      ) : (
        <div className={classes.empty}>
          <IconSparkles size={32} stroke={1.5} className={classes.emptyIcon} />
          <div className={classes.emptyTitle}>{t("Ask about this page")}</div>
          <div className={classes.quick}>
            {quick.map((q) => (
              <button key={q.label} type="button" className={classes.quickButton} onClick={() => send(q.prompt, [], [])}>
                <q.icon size={16} />
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={classes.inputArea}>
        <ChatInput
          isStreaming={chat.isStreaming}
          onSend={send}
          onStop={chat.stop}
          placeholder={t("Ask anything…")}
          autofocus={false}
          contextPages={contextPages}
          onRemoveContextPage={(id) => setContextPages((prev) => prev.filter((p) => p.id !== id))}
          variant="flat"
          chatId={chatId}
        />
      </div>
    </div>
  );
}

function History({ activeChatId, onSelect }: { activeChatId?: string; onSelect: (chatId: string) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const searching = debounced.trim().length > 0;
  const chatsQuery = useChatsQuery();
  const searchQuery = useSearchChatsQuery(debounced);
  const chats = searching ? searchQuery.data ?? [] : chatsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const loading = searching ? searchQuery.isLoading : chatsQuery.isLoading;

  return (
    <div>
      <TextInput
        placeholder={t("Search chats…")}
        leftSection={<IconSearch size={14} />}
        size="xs"
        mb="xs"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {loading ? (
        <Loader size="sm" mx="auto" my="sm" display="block" />
      ) : chats.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          {searching ? t("No chats match") : t("No chats yet")}
        </Text>
      ) : (
        <ScrollArea.Autosize mah={300} scrollbars="y">
          {chats.map((c) => (
            <UnstyledButton
              key={c.id}
              className={classes.historyItem}
              data-active={c.id === activeChatId || undefined}
              onClick={() => onSelect(c.id)}
            >
              {c.title || t("Untitled chat")}
            </UnstyledButton>
          ))}
        </ScrollArea.Autosize>
      )}
    </div>
  );
}
