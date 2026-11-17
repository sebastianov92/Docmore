import { useEffect, useState } from "react";
import {
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconRosetteDiscountCheckFilled } from "@tabler/icons-react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { MAX_VERIFIERS } from "@/features/page-verification/constants";
import { reviewChangesAtom } from "@/features/page-verification/atoms";
import {
  useMarkObsoleteMutation,
  usePageVerificationInfoQuery,
  useRejectApprovalMutation,
  useRemoveVerificationMutation,
  useSubmitForApprovalMutation,
  useUpdateVerificationMutation,
  useVerifyPageMutation,
} from "@/features/page-verification/queries";
import { IPageVerificationInfo } from "@/features/page-verification/types";
import { canReviewChanges } from "@/features/page-verification/utils";
import ExpirationFields, { ExpirationValue, isExpirationValid } from "./expiration-fields";
import VerifierPicker from "./verifier-picker";
import VerifierList from "./verifier-list";
import { statusCssColor, statusLabel } from "./status";
import classes from "./verification.module.css";

interface Props {
  pageId: string;
  onClose: () => void;
}

export default function ManageForm({ pageId, onClose }: Props) {
  const { data: info, isLoading } = usePageVerificationInfoQuery(pageId);
  if (isLoading || !info) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }
  return info.type === "qms" ? (
    <ApprovalPanel pageId={pageId} info={info} onClose={onClose} />
  ) : (
    <RecurringPanel pageId={pageId} info={info} onClose={onClose} />
  );
}

interface PanelProps {
  pageId: string;
  info: IPageVerificationInfo;
  onClose: () => void;
}

function StatusLine({ info }: { info: IPageVerificationInfo }) {
  const { t } = useTranslation();
  const verifiedAgo = useTimeAgo(info.verifiedAt ?? undefined);
  const requestedAgo = useTimeAgo(info.requestedAt ?? undefined);
  const rejectedAgo = useTimeAgo(info.rejectedAt ?? undefined);
  const changedAgo = useTimeAgo(info.invalidatedAt ?? undefined);
  const who = (u?: { name: string } | null) => u?.name ?? t("Someone");

  let detail: string | null = null;
  switch (info.status) {
    case "verified":
    case "expiring":
      detail = info.expiresAt
        ? t("Verified by {{name}} {{time}}. Expires {{date}}.", {
            name: who(info.verifiedBy),
            time: verifiedAgo,
            date: new Date(info.expiresAt).toLocaleDateString(),
          })
        : t("Verified by {{name}} {{time}}.", { name: who(info.verifiedBy), time: verifiedAgo });
      break;
    case "expired":
      detail = t("Last verified by {{name}} {{time}}. It needs a fresh look.", {
        name: who(info.verifiedBy),
        time: verifiedAgo,
      });
      break;
    case "invalidated":
      detail = t("Changed by {{name}} {{time}} after the last verification.", {
        name: who(info.invalidatedBy),
        time: changedAgo,
      });
      break;
    case "draft":
      detail = info.rejectedAt
        ? t("Returned by {{name}} {{time}}.", { name: who(info.rejectedBy), time: rejectedAgo })
        : info.invalidatedAt
          ? t("Changed by {{name}} {{time}}; submit it again when ready.", {
              name: who(info.invalidatedBy),
              time: changedAgo,
            })
          : t("Not submitted for approval yet.");
      break;
    case "in_approval":
      detail = t("Submitted by {{name}} {{time}}.", { name: who(info.requestedBy), time: requestedAgo });
      break;
    case "approved":
      detail = t("Approved by {{name}} {{time}}.", { name: who(info.verifiedBy), time: verifiedAgo });
      break;
    case "obsolete":
      detail = t("Marked obsolete. Readers see it is no longer current.");
      break;
  }

  return (
    <div className={classes.statusLine}>
      <IconRosetteDiscountCheckFilled size={20} color={statusCssColor(info.status)} aria-hidden />
      <div>
        <Text size="sm" fw={600}>
          {statusLabel(info.status, t)}
        </Text>
        {detail && (
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        )}
        {info.status === "draft" && info.rejectionComment && (
          <Text size="xs" mt={4} fs="italic">
            “{info.rejectionComment}”
          </Text>
        )}
      </div>
    </div>
  );
}

function ReviewChangesButton({ pageId, info }: { pageId: string; info: IPageVerificationInfo }) {
  const { t } = useTranslation();
  const setReview = useSetAtom(reviewChangesAtom);
  if (!canReviewChanges(info)) return null;
  return (
    <Button variant="light" size="compact-sm" onClick={() => setReview({ pageId, source: "modal" })}>
      {t("Review changes")}
    </Button>
  );
}

function VerifiersSection({ pageId, info }: { pageId: string; info: IPageVerificationInfo }) {
  const { t } = useTranslation();
  const update = useUpdateVerificationMutation();
  const verifiers = info.verifiers ?? [];
  const canManage = !!info.permissions?.canManage && info.status !== "obsolete";
  return (
    <div>
      <div className={classes.section}>{t("Verifiers")}</div>
      <VerifierList
        verifiers={verifiers}
        removable={canManage && verifiers.length > 1}
        onRemove={(id) =>
          update.mutate({ pageId, verifierIds: verifiers.filter((v) => v.id !== id).map((v) => v.id) })
        }
      />
      {canManage && verifiers.length < MAX_VERIFIERS && (
        <div style={{ marginTop: 8 }}>
          <VerifierPicker
            excludeIds={verifiers.map((v) => v.id)}
            onSelect={(user) => update.mutate({ pageId, verifierIds: [...verifiers.map((v) => v.id), user.id] })}
            disabled={update.isPending}
          />
        </div>
      )}
    </div>
  );
}

function useRemoveConfirm(pageId: string, onClose: () => void) {
  const { t } = useTranslation();
  const remove = useRemoveVerificationMutation();
  return {
    pending: remove.isPending,
    ask: () =>
      modals.openConfirmModal({
        title: t("Remove verification"),
        centered: true,
        children: (
          <Text size="sm">
            {t("The page keeps its content; the verification history and verifiers are removed.")}
          </Text>
        ),
        labels: { confirm: t("Remove"), cancel: t("Cancel") },
        confirmProps: { color: "red" },
        onConfirm: () => remove.mutate(pageId, { onSuccess: onClose }),
      }),
  };
}

function RecurringPanel({ pageId, info, onClose }: PanelProps) {
  const { t } = useTranslation();
  const verify = useVerifyPageMutation();
  const update = useUpdateVerificationMutation();
  const remove = useRemoveConfirm(pageId, onClose);
  const [confirmed, setConfirmed] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationValue>(() => fromInfo(info));
  useEffect(() => setExpiration(fromInfo(info)), [info.mode, info.periodAmount, info.periodUnit, info.expiresAt]);

  const canManage = !!info.permissions?.canManage;
  const canVerify = !!info.permissions?.canVerify;
  const settingsDirty =
    expiration.mode !== (info.mode ?? "period") ||
    (expiration.mode === "period" &&
      (expiration.periodAmount !== info.periodAmount || expiration.periodUnit !== info.periodUnit)) ||
    (expiration.mode === "fixed" &&
      expiration.fixedDate?.toISOString() !== (info.expiresAt ? new Date(info.expiresAt).toISOString() : undefined));

  const saveSettings = () =>
    update.mutate({
      pageId,
      mode: expiration.mode,
      ...(expiration.mode === "period" && {
        periodAmount: expiration.periodAmount,
        periodUnit: expiration.periodUnit,
      }),
      ...(expiration.mode === "fixed" &&
        expiration.fixedDate && { fixedExpiresAt: expiration.fixedDate.toISOString() }),
    });

  return (
    <Stack gap="md">
      <StatusLine info={info} />
      <ReviewChangesButton pageId={pageId} info={info} />
      <VerifiersSection pageId={pageId} info={info} />

      {canManage && (
        <>
          <Divider />
          <div>
            <div className={classes.section}>{t("Expires")}</div>
            <ExpirationFields
              value={expiration}
              onChange={setExpiration}
              from={info.verifiedAt ? new Date(info.verifiedAt) : undefined}
            />
            {settingsDirty && (
              <Group justify="flex-end" mt="xs">
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={saveSettings}
                  loading={update.isPending}
                  disabled={!isExpirationValid(expiration)}
                >
                  {t("Save schedule")}
                </Button>
              </Group>
            )}
          </div>
        </>
      )}

      {canVerify && (
        <>
          <Divider />
          <Checkbox
            label={t("I have reviewed this page and it is accurate")}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.currentTarget.checked)}
          />
        </>
      )}

      <Group justify="space-between">
        {canManage ? (
          <Button variant="subtle" color="red" size="compact-sm" onClick={remove.ask} loading={remove.pending}>
            {t("Remove verification")}
          </Button>
        ) : (
          <span />
        )}
        {canVerify && (
          <Button
            onClick={() => verify.mutate(pageId, { onSuccess: () => setConfirmed(false) })}
            disabled={!confirmed}
            loading={verify.isPending}
            color={info.status === "expired" ? "red" : undefined}
          >
            {info.status === "verified" ? t("Verify again") : t("Verify page")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function fromInfo(info: IPageVerificationInfo): ExpirationValue {
  return {
    mode: info.mode ?? "period",
    periodAmount: info.periodAmount ?? 1,
    periodUnit: info.periodUnit ?? "month",
    fixedDate: info.mode === "fixed" && info.expiresAt ? new Date(info.expiresAt) : null,
  };
}

function ApprovalPanel({ pageId, info, onClose }: PanelProps) {
  const { t } = useTranslation();
  const verify = useVerifyPageMutation();
  const submit = useSubmitForApprovalMutation();
  const reject = useRejectApprovalMutation();
  const obsolete = useMarkObsoleteMutation();
  const remove = useRemoveConfirm(pageId, onClose);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const p = info.permissions;
  const status = info.status;

  const askObsolete = () =>
    modals.openConfirmModal({
      title: t("Mark as obsolete"),
      centered: true,
      children: (
        <Text size="sm">
          {t("The page stays readable but is marked as no longer current. This cannot be undone from here.")}
        </Text>
      ),
      labels: { confirm: t("Mark obsolete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => obsolete.mutate(pageId),
    });

  return (
    <Stack gap="md">
      <StatusLine info={info} />
      <ReviewChangesButton pageId={pageId} info={info} />
      <VerifiersSection pageId={pageId} info={info} />

      {status === "in_approval" && p?.canVerify && (
        <>
          <Divider />
          {rejecting ? (
            <Stack gap="xs">
              <Textarea
                label={t("Why is it going back?")}
                placeholder={t("What needs to change before it can be approved")}
                value={comment}
                onChange={(e) => setComment(e.currentTarget.value)}
                autosize
                minRows={2}
                maxLength={2000}
              />
              <Group justify="flex-end" gap="xs">
                <Button variant="default" size="compact-sm" onClick={() => setRejecting(false)}>
                  {t("Cancel")}
                </Button>
                <Button
                  color="red"
                  size="compact-sm"
                  loading={reject.isPending}
                  onClick={() =>
                    reject.mutate(
                      { pageId, comment: comment.trim() || undefined },
                      {
                        onSuccess: () => {
                          setRejecting(false);
                          setComment("");
                        },
                      },
                    )
                  }
                >
                  {t("Return to draft")}
                </Button>
              </Group>
            </Stack>
          ) : (
            <Checkbox
              label={t("I have reviewed this version and approve it")}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.currentTarget.checked)}
            />
          )}
        </>
      )}

      <Group justify="space-between">
        {p?.canManage && status !== "obsolete" ? (
          <Button variant="subtle" color="red" size="compact-sm" onClick={remove.ask} loading={remove.pending}>
            {t("Remove verification")}
          </Button>
        ) : (
          <span />
        )}
        <Group gap="xs">
          {status === "draft" && p?.canSubmitForApproval && (
            <Button onClick={() => submit.mutate(pageId)} loading={submit.isPending}>
              {t("Submit for approval")}
            </Button>
          )}
          {status === "in_approval" && p?.canVerify && !rejecting && (
            <>
              <Button variant="default" onClick={() => setRejecting(true)}>
                {t("Reject")}
              </Button>
              <Button
                onClick={() => verify.mutate(pageId, { onSuccess: () => setConfirmed(false) })}
                disabled={!confirmed}
                loading={verify.isPending}
              >
                {t("Approve")}
              </Button>
            </>
          )}
          {status === "approved" && p?.canSubmitForApproval && (
            <Button variant="default" onClick={() => submit.mutate(pageId)} loading={submit.isPending}>
              {t("Submit a new version")}
            </Button>
          )}
          {status === "approved" && p?.canMarkObsolete && (
            <Button color="red" variant="light" onClick={askObsolete} loading={obsolete.isPending}>
              {t("Mark obsolete")}
            </Button>
          )}
        </Group>
      </Group>
    </Stack>
  );
}
