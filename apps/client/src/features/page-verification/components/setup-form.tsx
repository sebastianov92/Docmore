import { useState } from "react";
import { Button, Checkbox, Divider, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconArrowLeft, IconCertificate, IconRefresh } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { MAX_VERIFIERS } from "@/features/page-verification/constants";
import { useSetupVerificationMutation } from "@/features/page-verification/queries";
import { IVerifier, VerificationType } from "@/features/page-verification/types";
import ExpirationFields, { ExpirationValue, isExpirationValid } from "./expiration-fields";
import VerifierPicker from "./verifier-picker";
import VerifierList from "./verifier-list";
import classes from "./verification.module.css";

interface Props {
  pageId: string;
  onClose: () => void;
}

// First visit: pick a workflow, name the verifiers and, for a recurring
// verification, confirm the page as it is now.
export default function SetupForm({ pageId, onClose }: Props) {
  const { t } = useTranslation();
  const currentUser = useAtomValue(currentUserAtom);
  const setup = useSetupVerificationMutation();
  const [type, setType] = useState<VerificationType | null>(null);
  const [verifiers, setVerifiers] = useState<IVerifier[]>(() => {
    const me = currentUser?.user;
    return me ? [{ id: me.id, name: me.name, email: me.email, avatarUrl: me.avatarUrl }] : [];
  });
  const [expiration, setExpiration] = useState<ExpirationValue>({
    mode: "period",
    periodAmount: 1,
    periodUnit: "month",
    fixedDate: null,
  });
  const [confirmed, setConfirmed] = useState(false);

  if (!type) {
    return (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("Choose how this page should stay accurate.")}
        </Text>
        <div className={classes.chooser}>
          <UnstyledButton className={classes.card} onClick={() => setType("expiring")}>
            <span className={classes.cardTitle}>
              <IconRefresh size={16} stroke={1.8} />
              {t("Recurring verification")}
            </span>
            <span className={classes.cardText}>
              {t("Verifiers confirm the page again on a schedule. Edits in between flag it as changed.")}
            </span>
            <span className={classes.cardText}>{t("For runbooks, FAQs, living docs.")}</span>
          </UnstyledButton>
          <UnstyledButton className={classes.card} onClick={() => setType("qms")}>
            <span className={classes.cardTitle}>
              <IconCertificate size={16} stroke={1.8} />
              {t("Approval workflow")}
            </span>
            <span className={classes.cardText}>
              {t("Draft, in approval, approved, obsolete. Named approvers sign off each version.")}
            </span>
            <span className={classes.cardText}>{t("For procedures and controlled documents.")}</span>
          </UnstyledButton>
        </div>
      </Stack>
    );
  }

  const isQms = type === "qms";
  const canSubmit =
    verifiers.length > 0 && (isQms || (confirmed && isExpirationValid(expiration)));

  const submit = () => {
    setup.mutate(
      {
        pageId,
        type,
        verifierIds: verifiers.map((v) => v.id),
        ...(!isQms && {
          mode: expiration.mode,
          ...(expiration.mode === "period" && {
            periodAmount: expiration.periodAmount,
            periodUnit: expiration.periodUnit,
          }),
          ...(expiration.mode === "fixed" &&
            expiration.fixedDate && { fixedExpiresAt: expiration.fixedDate.toISOString() }),
        }),
      },
      { onSuccess: () => !isQms && onClose() },
    );
  };

  return (
    <Stack gap="md">
      <div>
        <Button
          variant="subtle"
          size="compact-xs"
          color="gray"
          leftSection={<IconArrowLeft size={12} />}
          onClick={() => setType(null)}
        >
          {t("Back")}
        </Button>
        <Text size="sm" c="dimmed" mt={4}>
          {isQms
            ? t("The page starts as a draft. Submit it when it is ready and an approver signs it off.")
            : t("You confirm the page now; verifiers are asked again before it expires.")}
        </Text>
      </div>

      <div>
        <div className={classes.section}>{t("Verifiers")}</div>
        <VerifierList
          verifiers={verifiers}
          removable
          onRemove={(id) => setVerifiers((prev) => prev.filter((v) => v.id !== id))}
        />
        {verifiers.length < MAX_VERIFIERS && (
          <div style={{ marginTop: 8 }}>
            <VerifierPicker
              excludeIds={verifiers.map((v) => v.id)}
              onSelect={(user) =>
                setVerifiers((prev) => (prev.some((v) => v.id === user.id) ? prev : [...prev, user]))
              }
            />
          </div>
        )}
      </div>

      {!isQms && (
        <>
          <Divider />
          <div>
            <div className={classes.section}>{t("Expires")}</div>
            <ExpirationFields value={expiration} onChange={setExpiration} />
          </div>
          <Divider />
          <Checkbox
            label={t("I have reviewed this page and it is accurate")}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.currentTarget.checked)}
          />
        </>
      )}

      <Group justify="flex-end">
        <Button onClick={submit} disabled={!canSubmit} loading={setup.isPending}>
          {isQms ? t("Start workflow") : t("Verify page")}
        </Button>
      </Group>
    </Stack>
  );
}
