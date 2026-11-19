import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Avatar, Button, Divider, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { notifications } from "@mantine/notifications";
import CommentEditor from "@/features/comment/components/comment-editor";
import { createComment, deleteComment, getPageComments } from "@/features/comment/services/comment-service";
import { IComment } from "@/features/comment/types/comment.types";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { IBase, IBaseRow } from "@/features/base/types/base.types";

export const rowCommentsKey = (pageId: string, rowId: string) => ["comments", pageId, "row", rowId];

// The conversation under one row: a flat thread apart from the page's own.
export function RowComments({ base, row, canEdit }: { base: IBase; row: IBaseRow; canEdit: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const key = rowCommentsKey(base.id, row.id);
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => getPageComments({ pageId: base.id, baseRowId: row.id, limit: 100 }),
  });
  const comments = data?.items ?? [];
  const [draft, setDraft] = useState<unknown>(null);
  const [editorKey, setEditorKey] = useState(0);
  const create = useMutation({
    mutationFn: () => createComment({ pageId: base.id, baseRowId: row.id, content: JSON.stringify(draft) } as any),
    onSuccess: () => {
      setDraft(null);
      setEditorKey((k) => k + 1);
      queryClient.invalidateQueries({ queryKey: key });
    },
    onError: () => notifications.show({ message: t("Error creating comment"), color: "red" }),
  });
  const remove = useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return (
    <Stack gap="xs" mt="md" data-testid="row-comments">
      <Divider label={`${t("Comments")} (${comments.length})`} labelPosition="left" />
      {comments.map((c) => (
        <RowComment key={c.id} comment={c} onDelete={() => remove.mutate(c.id)} />
      ))}
      {canEdit && (
        <Stack gap={4}>
          <CommentEditor
            key={editorKey}
            editable
            placeholder={t("Write a comment…")}
            onUpdate={(json: unknown) => setDraft(json)}
            onSave={() => draft && create.mutate()}
          />
          <Group justify="flex-end">
            <Button size="compact-xs" disabled={!draft} loading={create.isPending} onClick={() => create.mutate()} data-testid="row-comment-send">
              {t("Comment")}
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

function RowComment({ comment, onDelete }: { comment: IComment; onDelete: () => void }) {
  const { t } = useTranslation();
  const [currentUser] = useAtom(currentUserAtom);
  const ago = useTimeAgo(comment.createdAt);
  const mine = currentUser?.user?.id === comment.creatorId;
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap" data-testid="row-comment">
      <Avatar src={comment.creator?.avatarUrl ?? undefined} name={comment.creator?.name ?? undefined} color="initials" size="sm" radius="xl" />
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} justify="space-between" wrap="nowrap">
          <Text size="sm" fw={500} truncate>
            {comment.creator?.name ?? t("Someone")}{" "}
            <Text span size="xs" c="dimmed">
              {ago}
            </Text>
          </Text>
          {mine && (
            <Tooltip label={t("Delete")}>
              <ActionIcon variant="subtle" color="gray" size="xs" onClick={onDelete} aria-label={t("Delete")}>
                <IconTrash size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <CommentEditor defaultContent={comment.content} editable={false} />
      </Stack>
    </Group>
  );
}
