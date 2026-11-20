import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { ActionIcon, Button, Code, Group, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconTrash } from "@tabler/icons-react";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import CopyTextButton from "@/components/common/copy.tsx";
import { createScimToken, listScimTokens, revokeScimToken } from "@/features/scim/services";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service";
import { getApiErrorMessage } from "@/lib/api-error";

// SCIM 2.0 provisioning: the switch, the base URL and the bearer tokens.
export default function ScimSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const { data } = useQuery({ queryKey: ["scim-tokens"], queryFn: listScimTokens });
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["scim-tokens"] });
  const fail = (err: unknown) => notifications.show({ message: getApiErrorMessage(err), color: "red" });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateWorkspace({ isScimEnabled: enabled } as any),
    onSuccess: (ws) => {
      setWorkspace(ws as any);
      refresh();
    },
    onError: fail,
  });
  const create = useMutation({
    mutationFn: () => createScimToken(name || undefined),
    onSuccess: (tok) => {
      setRevealed(tok.token ?? null);
      setName("");
      refresh();
    },
    onError: fail,
  });
  const revoke = useMutation({ mutationFn: revokeScimToken, onSuccess: refresh, onError: fail });
  const enabled = Boolean((workspace as any)?.isScimEnabled ?? data?.enabled);

  return (
    <>
      <DocumentTitle title={t("SCIM provisioning")} />
      <SettingsTitle title={t("SCIM provisioning")} />
      <Stack gap="lg" maw={760}>
        <Switch label={t("Allow identity providers to create, update and deactivate members and groups")} checked={enabled} onChange={(e) => toggle.mutate(e.currentTarget.checked)} data-testid="scim-switch" />
        {data?.baseUrl && (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">{t("SCIM base URL")}</Text>
            <Code>{data.baseUrl}</Code>
            <CopyTextButton text={data.baseUrl} />
          </Group>
        )}
        <Text size="sm" c="dimmed">
          {t("Point Okta, Entra ID or JumpCloud at the base URL with a token below as the bearer token. Users deprovisioned by the IdP are deactivated, never deleted.")}
        </Text>
        {revealed && (
          <Group gap="xs" wrap="nowrap" data-testid="scim-token">
            <Text size="sm">{t("Token (shown once):")}</Text>
            <Code>{revealed}</Code>
            <CopyTextButton text={revealed} />
          </Group>
        )}
        <Table fz="sm">
          <Table.Tbody>
            {(data?.items ?? []).map((tok) => (
              <Table.Tr key={tok.id}>
                <Table.Td>{tok.name}</Table.Td>
                <Table.Td>
                  <Code>…{tok.tokenLastFour}</Code>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {tok.lastUsedAt ? `${t("last used")} ${new Date(tok.lastUsedAt).toLocaleString()}` : t("never used")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <ActionIcon variant="subtle" color="red" size="sm" onClick={() => revoke.mutate(tok.id)} aria-label={t("Revoke")}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group gap="xs" align="flex-end">
          <TextInput size="xs" w={220} label={t("Token name")} placeholder="Okta" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Button size="xs" onClick={() => create.mutate()} loading={create.isPending} disabled={!enabled} data-testid="scim-create-token">
            {t("Create token")}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
