import { useAtom, useSetAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Badge, Button, Tooltip } from "@mantine/core";
import { IconPencilQuestion } from "@tabler/icons-react";
import { IPage } from "@/features/page/types/page.types";
import { countSuggestions, SUGGESTION_COUNT_KEY, suggestEditorOpenAtom, suggestionsModalOpenAtom } from "../services";

// In the header: readers get "Suggest edits"; editors get the open count.
export function SuggestButton({ page, readOnly }: { page: IPage | undefined; readOnly?: boolean }) {
  const { t } = useTranslation();
  const setEditorOpen = useSetAtom(suggestEditorOpenAtom);
  const [, setListOpen] = useAtom(suggestionsModalOpenAtom);
  const count = useQuery({ queryKey: SUGGESTION_COUNT_KEY(page?.id ?? ""), queryFn: () => countSuggestions(page?.id as string), enabled: Boolean(page?.id) && !page?.isBase, staleTime: 30_000 });
  if (!page || page.isBase || page.deletedAt) return null;
  const open = count.data?.open ?? 0;
  if (readOnly) {
    return (
      <Tooltip label={t("Propose changes for an editor to accept")} openDelay={250} withArrow>
        <Button size="xs" variant="default" leftSection={<IconPencilQuestion size={14} />} onClick={() => setEditorOpen(true)} data-testid="suggest-edits">
          {t("Suggest edits")}
        </Button>
      </Tooltip>
    );
  }
  if (!open) return null;
  return (
    <Tooltip label={t("Suggested edits waiting for review")} openDelay={250} withArrow>
      <Badge size="lg" variant="light" color="blue" style={{ cursor: "pointer" }} leftSection={<IconPencilQuestion size={12} />} onClick={() => setListOpen(true)} data-testid="suggestions-badge">
        {open}
      </Badge>
    </Tooltip>
  );
}
