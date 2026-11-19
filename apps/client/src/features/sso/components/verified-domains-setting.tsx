import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconTrash } from "@tabler/icons-react";
import {
  addWorkspaceDomain,
  getWorkspaceDomains,
  removeWorkspaceDomain,
  setWorkspaceDomainAutoJoin,
  verifyWorkspaceDomain,
} from "@/features/workspace/services/workspace-service";
import { IWorkspaceDomains } from "@/features/workspace/types/workspace.types";

const KEY = ["workspace-domains"];

// Prove a domain with a DNS TXT record; verified domains can let their
// people sign up without an invitation.
export default function VerifiedDomainsSetting() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: getWorkspaceDomains });
  const [draft, setDraft] = useState("");
  const done = (result: IWorkspaceDomains) => queryClient.setQueryData(KEY, result);
  const fail = (err: any) =>
    notifications.show({ message: err?.response?.data?.message || t("Something went wrong"), color: "red" });
  const add = useMutation({ mutationFn: addWorkspaceDomain, onSuccess: (r) => { done(r); setDraft(""); }, onError: fail });
  const verify = useMutation({
    mutationFn: verifyWorkspaceDomain,
    onSuccess: (r) => { done(r); notifications.show({ message: t("Domain verified") }); },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: removeWorkspaceDomain, onSuccess: done, onError: fail });
  const autoJoin = useMutation({ mutationFn: setWorkspaceDomainAutoJoin, onSuccess: done, onError: fail });
  const domains = data?.verified ?? [];
  const hasVerified = domains.some((d) => d.verifiedAt);

  return (
    <div data-testid="verified-domains">
      <Text size="md">{t("Verified domains")}</Text>
      <Text size="sm" c="dimmed">
        {t("Prove you own a domain with a DNS TXT record. Verified domains can let anyone with that email sign up on their own.")}
      </Text>
      <Group mt="sm" gap="xs" align="flex-end">
        <TextInput
          placeholder={t("e.g acme.com")}
          variant="filled"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) add.mutate(draft.trim());
          }}
          style={{ flex: 1 }}
          aria-label={t("Domain")}
        />
        <Button onClick={() => add.mutate(draft.trim())} disabled={!draft.trim()} loading={add.isPending}>
          {t("Add domain")}
        </Button>
      </Group>
      <Stack gap="xs" mt="sm">
        {domains.map((d) => (
          <Group key={d.domain} justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Text size="sm" fw={500}>
                  {d.domain}
                </Text>
                <Badge size="xs" variant="light" color={d.verifiedAt ? "green" : "orange"}>
                  {d.verifiedAt ? t("Verified") : t("Pending")}
                </Badge>
              </Group>
              {!d.verifiedAt && (
                <Text size="xs" c="dimmed">
                  {t("Add a TXT record on")} <Code>{d.domain}</Code> {t("with the value")}{" "}
                  <Code>
                    {data?.txtPrefix}
                    {d.token}
                  </Code>
                </Text>
              )}
            </div>
            <Group gap="xs" wrap="nowrap">
              {!d.verifiedAt && (
                <Button size="xs" variant="default" onClick={() => verify.mutate(d.domain)} loading={verify.isPending}>
                  {t("Verify")}
                </Button>
              )}
              <Tooltip label={t("Remove")}>
                <ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(d.domain)} aria-label={t("Remove")}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        ))}
      </Stack>
      <Group justify="space-between" wrap="nowrap" mt="md">
        <div>
          <Text size="sm">{t("Let people with a verified domain email sign up")}</Text>
          <Text size="xs" c="dimmed">
            {t("They join as members from the login page, no invitation needed.")}
          </Text>
        </div>
        <Switch
          checked={data?.autoJoin === true}
          onChange={(e) => autoJoin.mutate(e.currentTarget.checked)}
          disabled={!hasVerified && !data?.autoJoin}
          aria-label={t("Toggle domain sign-up")}
        />
      </Group>
    </div>
  );
}
