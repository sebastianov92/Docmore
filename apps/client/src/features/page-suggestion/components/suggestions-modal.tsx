import { useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Group, Modal, ScrollArea, SegmentedControl, Stack, Text, Textarea, UnstyledButton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconSparkles, IconX } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";
import { HistoryEditor } from "@/features/page-history/components/history-editor";
import { highlightChangesAtom } from "@/features/page-history/atoms/history-atoms";
import { IPage } from "@/features/page/types/page.types";
import { useAtomValue } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { getApiErrorMessage } from "@/lib/api-error";
import { acceptSuggestion, ISuggestion, listSuggestions, rejectSuggestion, SUGGESTION_COUNT_KEY, SUGGESTIONS_KEY, suggestionInfo, suggestionsModalOpenAtom, withdrawSuggestion } from "../services";

// Who is behind a suggestion the assistant wrote: the chat, a scheduled
// agent (by its name) or an outside tool.
export function originText(s: Pick<ISuggestion, "origin" | "originLabel">, t: (key: string, values?: Record<string, unknown>) => string): string | null {
  if (!s.origin) return null;
  if (s.origin === "agent") return s.originLabel ? t("Agent: {{name}}", { name: s.originLabel }) : t("Scheduled agent");
  if (s.origin === "mcp") return t("Connected AI tool");
  return t("Assistant");
}

// The suggestions of a page: pick one, see what it changes against the page
// as it is now, accept it (the page takes that version) or reject it.
export function SuggestionsModal({ page }: { page: IPage | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useAtom(suggestionsModalOpenAtom);
  const setHighlight = useSetAtom(highlightChangesAtom);
  const me = useAtomValue(currentUserAtom);
  const [status, setStatus] = useState("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // a suggestion opened from a link stays selected whatever the list shows
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const pageId = page?.id ?? "";
  const linked = searchParams.get("suggestion");
  useEffect(() => {
    if (!linked || !pageId) return;
    setLinkedId(linked);
    setSelectedId(linked);
    setOpen(true);
    const rest = new URLSearchParams(searchParams);
    rest.delete("suggestion");
    setSearchParams(rest, { replace: true });
  }, [linked, pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useQuery({ queryKey: [...SUGGESTIONS_KEY(pageId), status], queryFn: () => listSuggestions(pageId, status), enabled: open && Boolean(pageId) });
  const detail = useQuery({ queryKey: ["page-suggestion", selectedId], queryFn: () => suggestionInfo(selectedId as string), enabled: open && Boolean(selectedId) });
  useEffect(() => {
    if (open) setHighlight(true);
  }, [open, setHighlight]);
  useEffect(() => {
    const items = list.data?.items ?? [];
    if (selectedId && selectedId === linkedId) return;
    if (!selectedId || !items.some((s) => s.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [list.data, selectedId, linkedId]);

  const done = (message: string) => {
    notifications.show({ message });
    setReviewNote("");
    queryClient.invalidateQueries({ queryKey: SUGGESTIONS_KEY(pageId) });
    queryClient.invalidateQueries({ queryKey: SUGGESTION_COUNT_KEY(pageId) });
    queryClient.invalidateQueries({ queryKey: ["page-suggestion", selectedId] });
    queryClient.invalidateQueries({ queryKey: ["pages", page?.slugId] });
  };
  const fail = (err: unknown) => notifications.show({ color: "red", message: getApiErrorMessage(err) });
  const accept = useMutation({ mutationFn: () => acceptSuggestion(selectedId as string, reviewNote || undefined), onSuccess: () => done(t("Suggestion accepted; the page was updated.")), onError: fail });
  const reject = useMutation({ mutationFn: () => rejectSuggestion(selectedId as string, reviewNote || undefined), onSuccess: () => done(t("Suggestion rejected.")), onError: fail });
  const withdraw = useMutation({ mutationFn: () => withdrawSuggestion(selectedId as string), onSuccess: () => done(t("Suggestion withdrawn.")), onError: fail });

  const items = list.data?.items ?? [];
  const selected = detail.data;

  return (
    <Modal opened={open} onClose={() => setOpen(false)} size="90%" title={t("Suggested edits")} data-testid="suggestions-modal">
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Stack gap="xs" w={260} style={{ flexShrink: 0 }}>
          <SegmentedControl
            size="xs"
            value={status}
            onChange={(v) => setStatus(String(v))}
            data={[
              { value: "open", label: t("Open") },
              { value: "accepted", label: t("Accepted") },
              { value: "rejected", label: t("Rejected") },
            ]}
          />
          <ScrollArea h={480}>
            <Stack gap={4}>
              {items.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t("Nothing here.")}
                </Text>
              )}
              {items.map((s: ISuggestion) => (
                <UnstyledButton
                  key={s.id}
                  onClick={() => {
                    setLinkedId(null);
                    setSelectedId(s.id);
                  }}
                  style={{ padding: "8px 10px", borderRadius: 8, background: s.id === selectedId ? "var(--mantine-color-default-hover)" : undefined, width: "100%" }}
                  data-testid="suggestion-row"
                >
                  <Text size="sm" fw={500} truncate>
                    {s.title || t("Content change")}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {s.author?.name ?? "?"} · {new Date(s.createdAt).toLocaleString()}
                  </Text>
                  {s.origin && (
                    <Group gap={4} wrap="nowrap" c="violet" data-testid="suggestion-origin">
                      <IconSparkles size={12} />
                      <Text size="xs" truncate>
                        {originText(s, t)}
                      </Text>
                    </Group>
                  )}
                  {s.note && (
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {s.note}
                    </Text>
                  )}
                </UnstyledButton>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
        <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Badge variant="light" color={selected.status === "open" ? "blue" : selected.status === "accepted" ? "teal" : "gray"}>
                    {selected.status === "open"
                      ? t("Suggestion: open")
                      : selected.status === "accepted"
                        ? t("Suggestion: accepted")
                        : selected.status === "rejected"
                          ? t("Suggestion: rejected")
                          : t("Suggestion: withdrawn")}
                  </Badge>
                  {selected.origin ? (
                    <>
                      <Badge variant="light" color="violet" leftSection={<IconSparkles size={12} />} data-testid="suggestion-origin-badge">
                        {originText(selected, t)}
                      </Badge>
                      <Text size="sm" c="dimmed">
                        {t("for {{name}}", { name: selected.author?.name ?? "?" })}
                      </Text>
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t("by {{name}}", { name: selected.author?.name ?? "?" })}
                    </Text>
                  )}
                </Group>
                {selected.status === "open" && (
                  <Group gap="xs" wrap="nowrap">
                    {selected.canReview && (
                      <>
                        <Button size="xs" leftSection={<IconCheck size={14} />} onClick={() => accept.mutate()} loading={accept.isPending} data-testid="suggestion-accept">
                          {t("Accept")}
                        </Button>
                        <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => reject.mutate()} loading={reject.isPending} data-testid="suggestion-reject">
                          {t("Reject")}
                        </Button>
                      </>
                    )}
                    {me?.user?.id === selected.authorId && (
                      <Button size="xs" variant="subtle" color="gray" onClick={() => withdraw.mutate()} loading={withdraw.isPending}>
                        {t("Withdraw")}
                      </Button>
                    )}
                  </Group>
                )}
              </Group>
              {selected.status === "open" && selected.canReview && (
                <Textarea size="xs" placeholder={t("Note for the author (optional)")} autosize minRows={1} value={reviewNote} onChange={(e) => setReviewNote(e.currentTarget.value)} />
              )}
              {selected.note && (
                <Text size="sm" data-testid="suggestion-note">
                  {selected.note}
                </Text>
              )}
              {selected.reviewNote && (
                <Text size="sm">
                  {t("Reviewer's note:")} {selected.reviewNote}
                </Text>
              )}
              <ScrollArea h={460} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: "0 16px" }}>
                <HistoryEditor title={selected.title ?? page?.title ?? ""} content={selected.content} previousContent={selected.pageContent ?? undefined} previousTitle={page?.title ?? ""} />
              </ScrollArea>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              {t("Pick a suggestion to see what it changes.")}
            </Text>
          )}
        </Stack>
      </Group>
    </Modal>
  );
}
