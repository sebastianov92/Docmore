import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Group, Modal, Stack, TagsInput, Text, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  useCreateInviteRequestMutation,
  useMyInviteRequestsQuery,
} from "@/features/workspace/queries/workspace-query.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Members cannot invite; they can ask the admins to.
export default function RequestInviteModal() {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [emails, setEmails] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const create = useCreateInviteRequestMutation();
  const { data: mine } = useMyInviteRequestsQuery(opened);
  const pending = (mine?.items ?? []).filter((r) => r.status === "pending");
  const valid = emails.filter((e) => EMAIL.test(e));

  const submit = async () => {
    if (valid.length === 0) return;
    try {
      await create.mutateAsync({ emails: valid, note: note.trim() || undefined });
      setEmails([]);
      setNote("");
      close();
    } catch {
      // the mutation shows the error
    }
  };

  return (
    <>
      <Button variant="default" onClick={open} data-testid="request-invite">
        {t("Request an invite")}
      </Button>
      <Modal opened={opened} onClose={close} title={t("Request an invite")} centered>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("An admin reviews the request and sends the invitation.")}
          </Text>
          <TagsInput
            label={t("Emails")}
            placeholder={t("name@company.com")}
            splitChars={[",", " "]}
            value={emails}
            onChange={(v) => setEmails(v.map((e) => e.trim().toLowerCase()))}
            error={emails.length > 0 && valid.length !== emails.length ? t("Check the emails") : undefined}
            data-autofocus
          />
          <Textarea
            label={t("Note for the admins")}
            placeholder={t("Why they should join")}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={500}
          />
          {pending.length > 0 && (
            <Text size="xs" c="dimmed">
              {t("Pending")}: {pending.map((r) => r.email).join(", ")}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button onClick={submit} loading={create.isPending} disabled={valid.length === 0}>
              {t("Send request")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
