import { ActionIcon, Tooltip } from "@mantine/core";
import { IconCircleCheck, IconCircleCheckFilled } from "@tabler/icons-react";
import { Editor } from "@tiptap/react";
import { isEditorReady } from "@docmost/editor-ext";
import { useTranslation } from "react-i18next";
import { useResolveCommentMutation } from "@/features/comment/queries/comment-query";

interface Props {
  editor: Editor | null;
  commentId: string;
  pageId: string;
  resolvedAt?: Date | null;
}

// Hover action on a thread: resolves it, or re-opens a resolved one. The
// inline highlight follows right away; the server syncs it for everyone else.
export default function ResolveCommentButton({
  editor,
  commentId,
  pageId,
  resolvedAt,
}: Props) {
  const { t } = useTranslation();
  const resolve = useResolveCommentMutation();
  const isResolved = resolvedAt != null;

  const toggle = async () => {
    try {
      await resolve.mutateAsync({ commentId, pageId, resolved: !isResolved });
      if (editor && isEditorReady(editor)) {
        editor.commands.setCommentResolved(commentId, !isResolved);
      }
    } catch {
      // The mutation already restored the cache and told the user.
    }
  };

  return (
    <Tooltip
      label={isResolved ? t("Re-open comment") : t("Resolve comment")}
      position="top"
    >
      <ActionIcon
        onClick={toggle}
        variant="subtle"
        color={isResolved ? "green" : "gray"}
        size="sm"
        loading={resolve.isPending}
        aria-label={isResolved ? t("Re-open comment") : t("Resolve comment")}
      >
        {isResolved ? (
          <IconCircleCheckFilled size={18} />
        ) : (
          <IconCircleCheck size={18} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}
