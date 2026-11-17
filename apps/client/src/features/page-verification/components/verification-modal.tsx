import { ActionIcon, Group, Menu, Modal, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconRosetteDiscountCheckFilled, IconShieldCheck } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { extractPageSlugId } from "@/lib";
import { usePageQuery } from "@/features/page/queries/page-query";
import { usePageVerificationInfoQuery } from "@/features/page-verification/queries";
import { reviewChangesAtom } from "@/features/page-verification/atoms";
import { useReviewDeepLink } from "@/features/page-verification/hooks/use-review-deep-link";
import SetupForm from "./setup-form";
import ManageForm from "./manage-form";
import ReviewChangesModal from "./review-changes-modal";
import { statusColor, statusCssColor, statusLabel } from "./status";

interface ModalProps {
  pageId: string;
  opened: boolean;
  onClose: () => void;
}

export function PageVerificationModal({ pageId, opened, onClose }: ModalProps) {
  const { t } = useTranslation();
  const { data: info } = usePageVerificationInfoQuery(opened ? pageId : undefined);
  // Mantine closes every modal on Escape; while the review dialog is on
  // top, leave the key to it.
  const reviewOpen = useAtomValue(reviewChangesAtom)?.pageId === pageId;
  const status = info?.status ?? "none";
  const title = status === "none" ? t("Set up verification") : t("Page verification");

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      closeOnEscape={!reviewOpen}
      size={520}
      title={
        <Group gap="xs">
          <IconShieldCheck size={20} stroke={1.5} color={status === "none" ? undefined : statusCssColor(status)} />
          <Text fw={600}>{title}</Text>
        </Group>
      }
    >
      {status === "none" ? (
        <SetupForm pageId={pageId} onClose={onClose} />
      ) : (
        <ManageForm pageId={pageId} onClose={onClose} />
      )}
    </Modal>
  );
}

// Header badge: shows the state and opens the dialog. On a page without a
// verification it is a quiet shield that starts one.
export function PageVerificationBadge({ readOnly }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const pageId = page?.id;
  const [opened, { open, close }] = useDisclosure(false);
  const { data: info, isLoading, refetch } = usePageVerificationInfoQuery(pageId);

  useReviewDeepLink({ pageId, refetchInfo: refetch, onOpenVerification: open });

  if (!pageId || isLoading) return null;
  const status = info?.status ?? "none";
  if (status === "none" && readOnly) return null;

  const label =
    status === "verified" && info?.expiresAt
      ? t("Verified until {{date}}", { date: new Date(info.expiresAt).toLocaleDateString() })
      : statusLabel(status, t);

  return (
    <>
      {status !== "none" ? (
        <Tooltip label={label} withArrow openDelay={250}>
          <UnstyledButton
            onClick={open}
            aria-label={label}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <IconRosetteDiscountCheckFilled size={18} color={statusCssColor(status)} aria-hidden />
            <Text size="sm" c={`${statusColor(status)}.7`}>
              {statusLabel(status, t)}
            </Text>
          </UnstyledButton>
        </Tooltip>
      ) : (
        <Tooltip label={t("Set up verification")} withArrow openDelay={250}>
          <ActionIcon variant="subtle" color="gray" onClick={open} aria-label={t("Set up verification")}>
            <IconShieldCheck size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      )}
      <PageVerificationModal pageId={pageId} opened={opened} onClose={close} />
      <ReviewChangesModal pageId={pageId} onOpenVerification={open} />
    </>
  );
}

export function PageVerificationMenuItem({ pageId, onClick }: { pageId?: string; onClick: () => void }) {
  const { t } = useTranslation();
  const { data: info } = usePageVerificationInfoQuery(pageId);
  const has = !!info && info.status !== "none";
  return (
    <Menu.Item leftSection={<IconShieldCheck size={16} />} onClick={onClick}>
      {has ? t("Verification") : t("Add verification")}
    </Menu.Item>
  );
}
