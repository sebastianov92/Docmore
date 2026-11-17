import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  getDefaultZIndex,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { HistoryEditor } from "@/features/page-history/components/history-editor";
import HistoryDiffBar from "@/features/page-history/components/history-diff-bar";
import { useDiffNavigation } from "@/features/page-history/hooks";
import { diffCountsAtom } from "@/features/page-history/atoms/history-atoms";
import { normalizeHistoryTitle } from "@/features/page-history/utils/normalize-history-title";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { reviewChangesAtom } from "@/features/page-verification/atoms";
import {
  usePageVerificationChangesQuery,
  usePageVerificationInfoQuery,
} from "@/features/page-verification/queries";
import { BaselineKind } from "@/features/page-verification/types";
import { containsDiagram, defaultBaselineKind } from "@/features/page-verification/utils";
import classes from "./review-changes-modal.module.css";

interface Props {
  pageId: string;
  onOpenVerification: () => void;
}

// Shows what changed since the page was last verified, approved or sent
// back, using the page history diff viewer.
export default function ReviewChangesModal({ pageId, onOpenVerification }: Props) {
  const { t } = useTranslation();
  const [request, setRequest] = useAtom(reviewChangesAtom);
  const isMobile = useMediaQuery("(max-width: 800px)");
  const opened = request?.pageId === pageId;

  useEffect(
    () => () => setRequest((cur) => (cur?.pageId === pageId ? null : cur)),
    [pageId, setRequest],
  );

  // Deferred so the verification modal underneath still sees this one open
  // for the same Escape keypress.
  const close = () =>
    setTimeout(() => setRequest((cur) => (cur?.pageId === pageId ? null : cur)), 0);

  return (
    <Modal.Root
      opened={opened}
      onClose={close}
      size={1000}
      fullScreen={isMobile}
      zIndex={getDefaultZIndex("modal") + 1}
      aria-label={t("Review changes")}
    >
      <Modal.Overlay />
      <Modal.Content styles={{ content: { overflow: "hidden" } }}>
        {opened && (
          <ReviewBody
            pageId={pageId}
            source={request?.source}
            isMobile={!!isMobile}
            onClose={close}
            onOpenVerification={onOpenVerification}
          />
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

function ReviewBody({
  pageId,
  source,
  isMobile,
  onClose,
  onOpenVerification,
}: {
  pageId: string;
  source: "modal" | "link" | undefined;
  isMobile: boolean;
  onClose: () => void;
  onOpenVerification: () => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<BaselineKind | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [diffCounts, setDiffCounts] = useAtom(diffCountsAtom);
  const { data: info } = usePageVerificationInfoQuery(pageId);
  const { data: changes, isError } = usePageVerificationChangesQuery(pageId, true);
  const { currentChangeIndex, handlePrevChange, handleNextChange } = useDiffNavigation(viewportRef);

  useEffect(() => {
    setDiffCounts(null);
    return () => setDiffCounts(null);
  }, [setDiffCounts]);

  const fallback = defaultBaselineKind(
    changes ?? { verified: info?.verifiedHistoryId, rejected: info?.rejectedHistoryId },
  );
  const kind: BaselineKind = choice && (!changes || changes[choice]) ? choice : (fallback ?? "verified");
  const baseline = changes?.[kind] ?? null;
  const decision =
    kind === "rejected"
      ? { at: changes?.rejected?.rejectedAt, by: changes?.rejected?.rejectedBy }
      : { at: changes?.verified?.verifiedAt, by: changes?.verified?.verifiedBy };
  const decisionAgo = useTimeAgo(decision.at ?? undefined);
  const type = changes?.type ?? info?.type;

  const heading =
    kind === "rejected"
      ? t("Changes since it was returned")
      : type === "qms"
        ? t("Changes since approval")
        : t("Changes since verification");
  const byLine =
    kind === "rejected"
      ? t("Returned by {{name}} {{time}}", { name: decision.by?.name ?? t("someone"), time: decisionAgo })
      : type === "qms"
        ? t("Approved by {{name}} {{time}}", { name: decision.by?.name ?? t("someone"), time: decisionAgo })
        : t("Verified by {{name}} {{time}}", { name: decision.by?.name ?? t("someone"), time: decisionAgo });

  const diagramNote = useMemo(
    () => !!changes && !!baseline && (containsDiagram(changes.current.content) || containsDiagram(baseline.content)),
    [changes, baseline],
  );
  const offerVerify =
    source === "link" &&
    !!info?.permissions?.canVerify &&
    (info.status === "in_approval" || info.status === "invalidated" || info.status === "expired");
  const height = isMobile ? undefined : 650;

  return (
    <>
      <Modal.Header>
        <Modal.Title>
          <Text size="md" fw={500}>
            {heading}
          </Text>
        </Modal.Title>
        <Modal.CloseButton aria-label={t("Close")} />
      </Modal.Header>
      <Modal.Body p={0}>
        {isError || (changes && !baseline) ? (
          <Box p="md">
            <Text size="sm">{t("Could not load the versions to compare.")}</Text>
          </Box>
        ) : !changes ? (
          <Box p="md" h={height}>
            <Stack gap="sm">
              <Skeleton height={12} width={260} />
              <Skeleton height={28} width="45%" mt="md" />
              {["96%", "88%", "92%", "70%", "84%"].map((w, i) => (
                <Skeleton key={i} height={12} width={w} />
              ))}
            </Stack>
          </Box>
        ) : (
          <>
            <div className={classes.meta}>
              {changes.verified && changes.rejected && (
                <SegmentedControl
                  size="xs"
                  value={kind}
                  onChange={(v) => {
                    setDiffCounts(null);
                    setChoice(v as BaselineKind);
                  }}
                  data={[
                    { label: t("Approved version"), value: "verified" },
                    { label: t("Returned version"), value: "rejected" },
                  ]}
                />
              )}
              <Text size="sm" c="dimmed">
                {decision.at ? `${byLine}. ` : ""}
                {t("Compared with the page as it is now.")}
              </Text>
              {!baseline.hasChanges && <Text size="sm">{t("The page matches that version.")}</Text>}
              {baseline.hasChanges && diffCounts?.total === 0 && (
                <Text size="sm">{t("Some changes, such as formatting, cannot be highlighted.")}</Text>
              )}
              {diagramNote && <Text size="sm">{t("Diagrams always show their latest drawing.")}</Text>}
            </div>
            <div className={classes.viewer}>
              <ScrollArea h={height} viewportRef={viewportRef} scrollbarSize={5} className={classes.scroll}>
                <div className={classes.document} data-mobile={isMobile || undefined}>
                  <HistoryEditor
                    title={normalizeHistoryTitle(changes.current.title)}
                    content={changes.current.content}
                    previousTitle={normalizeHistoryTitle(baseline.title)}
                    previousContent={baseline.content}
                  />
                </div>
              </ScrollArea>
              <HistoryDiffBar
                compact={isMobile}
                currentChangeIndex={currentChangeIndex}
                onPrev={handlePrevChange}
                onNext={handleNextChange}
                style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)" }}
              />
            </div>
          </>
        )}
        {offerVerify && (
          <Group justify="flex-end" gap="sm" className={classes.footer}>
            <Button variant="default" onClick={onClose}>
              {t("Close")}
            </Button>
            <Button
              onClick={() => {
                onClose();
                onOpenVerification();
              }}
            >
              {t("Open verification")}
            </Button>
          </Group>
        )}
      </Modal.Body>
    </>
  );
}
