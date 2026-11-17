import { useState } from "react";
import { Alert, Button, Group, Space, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconInfoCircle, IconPlus } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import Paginate from "@/components/common/paginate";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import useUserRole from "@/hooks/use-user-role.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import {
  useApiKeysQuery,
  useRevokeApiKeyMutation,
} from "@/features/api-key/queries/api-key-query.ts";
import { IApiKey } from "@/features/api-key/types/api-key.types.ts";
import { ApiKeyTable } from "./api-key-table.tsx";
import { CreateApiKeyModal } from "./create-api-key-modal.tsx";
import { ApiKeyCreatedModal } from "./api-key-created-modal.tsx";
import { RenameApiKeyModal } from "./rename-api-key-modal.tsx";

interface ApiKeyManagerProps {
  // Admin view lists every key in the workspace; otherwise only the user's own.
  adminView?: boolean;
  description: string;
}

export function ApiKeyManager({ adminView = false, description }: ApiKeyManagerProps) {
  const { t } = useTranslation();
  const { cursor, goNext, goPrev } = useCursorPaginate();
  const { isAdmin } = useUserRole();
  const [workspace] = useAtom(workspaceAtom);
  const [createOpened, setCreateOpened] = useState(false);
  const [created, setCreated] = useState<IApiKey | null>(null);
  const [renaming, setRenaming] = useState<IApiKey | null>(null);
  const revokeMutation = useRevokeApiKeyMutation();

  const { data } = useApiKeysQuery({ cursor, adminView });

  const restrictedToAdmins = workspace?.settings?.api?.restrictToAdmins === true;
  const canCreate = isAdmin || !restrictedToAdmins;

  const confirmRevoke = (apiKey: IApiKey) => {
    modals.openConfirmModal({
      title: t("Revoke API key"),
      centered: true,
      children: (
        <Text size="sm">
          {t('Anything still using "{{name}}" will stop working right away. This cannot be undone.', {
            name: apiKey.name,
          })}
        </Text>
      ),
      labels: { confirm: t("Revoke"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => revokeMutation.mutate(apiKey.id),
    });
  };

  return (
    <>
      <Group justify="space-between" align="flex-start" mb="md" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {description}
        </Text>
        {canCreate && (
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setCreateOpened(true)}
            style={{ flexShrink: 0 }}
          >
            {t("Create API key")}
          </Button>
        )}
      </Group>

      {!canCreate && (
        <Alert variant="light" color="yellow" mb="md" p="sm" icon={<IconInfoCircle />}>
          <Text size="sm">
            {t("Only workspace admins can create API keys here. Ask an admin for one.")}
          </Text>
        </Alert>
      )}

      <ApiKeyTable
        apiKeys={data?.items ?? []}
        showUserColumn={adminView}
        onRename={setRenaming}
        onRevoke={confirmRevoke}
      />

      <Space h="md" />

      {data?.items && data.items.length > 0 && (
        <Paginate
          hasPrevPage={data.meta?.hasPrevPage}
          hasNextPage={data.meta?.hasNextPage}
          onNext={() => goNext(data.meta?.nextCursor)}
          onPrev={goPrev}
        />
      )}

      <CreateApiKeyModal
        opened={createOpened}
        onClose={() => setCreateOpened(false)}
        onCreated={(apiKey) => {
          setCreateOpened(false);
          setCreated(apiKey);
        }}
      />

      <ApiKeyCreatedModal apiKey={created} onClose={() => setCreated(null)} />

      <RenameApiKeyModal apiKey={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}
