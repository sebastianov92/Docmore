import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { getApiErrorMessage } from "@/lib/api-error";
import { deleteChat, getChatInfo, listChats, renameChat, searchChats } from "./services";

export const AI_CHATS_KEY = ["ai-chats"];
export const aiChatKey = (chatId: string | undefined) => ["ai-chat", chatId];

export function useChatsQuery(enabled = true) {
  return useInfiniteQuery({
    queryKey: AI_CHATS_KEY,
    queryFn: ({ pageParam }) => listChats({ cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.meta.hasNextPage ? last.meta.nextCursor : undefined),
    enabled,
  });
}

export function useChatInfoQuery(chatId: string | undefined) {
  return useQuery({
    queryKey: aiChatKey(chatId),
    queryFn: () => getChatInfo(chatId!),
    enabled: !!chatId,
    retry: false,
  });
}

export function useSearchChatsQuery(query: string) {
  return useQuery({
    queryKey: ["ai-chats-search", query],
    queryFn: () => searchChats(query),
    enabled: query.trim().length > 0,
  });
}

export function useDeleteChatMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (chatId: string) => deleteChat(chatId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY }),
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t("Could not delete the chat")), color: "red" });
    },
  });
}

export function useRenameChatMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) => renameChat(chatId, title),
    onSuccess: (chat) => {
      queryClient.invalidateQueries({ queryKey: AI_CHATS_KEY });
      queryClient.invalidateQueries({ queryKey: aiChatKey(chat.id) });
    },
    onError: (err) => {
      notifications.show({ message: getApiErrorMessage(err, t("Could not rename the chat")), color: "red" });
    },
  });
}
