import { useState } from "react";
import { Button, Divider, Group, Text, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  useCreateSsoProviderMutation,
  useSsoProvidersQuery,
} from "@/features/sso/queries/sso-query.ts";
import { ISsoProvider } from "@/features/sso/types/sso.types.ts";
import EnforceSsoSetting from "@/features/sso/components/enforce-sso-setting.tsx";
import AllowedDomainsSetting from "@/features/sso/components/allowed-domains-setting.tsx";
import SsoProviderList from "@/features/sso/components/sso-provider-list.tsx";

// Settings > Security & SSO. Two-factor enforcement stays under General.
export default function Security() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const { data, isLoading } = useSsoProvidersQuery();
  const createMutation = useCreateSsoProviderMutation();
  const [editing, setEditing] = useState<ISsoProvider | null>(null);

  if (!isAdmin) {
    return null;
  }

  const providers = data?.items ?? [];
  const hasActiveProvider = providers.some((p) => p.isEnabled);

  // Keep the modal in sync with the latest server copy of the row.
  const current = editing
    ? providers.find((p) => p.id === editing.id) ?? editing
    : null;

  const handleAdd = async () => {
    try {
      const created = await createMutation.mutateAsync({
        type: "oidc",
        name: t("OpenID Connect"),
      });
      setEditing(created);
    } catch {
      // The mutation already showed the server's message.
    }
  };

  return (
    <>
      <DocumentTitle title={t("Security & SSO")} />
      <SettingsTitle title={t("Security & SSO")} />

      <Title order={4} my="lg">
        {t("Single sign-on (SSO)")}
      </Title>

      <EnforceSsoSetting hasActiveProvider={hasActiveProvider} />
      <Divider my="lg" />

      <AllowedDomainsSetting />
      <Divider my="lg" />

      <Group justify="space-between" align="flex-start" mb="md" wrap="nowrap">
        <div>
          <Text size="md">{t("Identity providers")}</Text>
          <Text size="sm" c="dimmed">
            {t("Any OpenID Connect provider works: Authelia, Authentik, Keycloak, Pocket ID, Google, Microsoft Entra.")}
          </Text>
        </div>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={handleAdd}
          loading={createMutation.isPending}
          style={{ flexShrink: 0 }}
        >
          {t("Add provider")}
        </Button>
      </Group>

      {!isLoading && (
        <SsoProviderList
          providers={providers}
          editing={current}
          onEdit={setEditing}
        />
      )}
    </>
  );
}
