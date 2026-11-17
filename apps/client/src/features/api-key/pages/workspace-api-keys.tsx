import { Divider } from "@mantine/core";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { ApiKeyManager } from "@/features/api-key/components/api-key-manager.tsx";
import { RestrictApiToAdmins } from "@/features/api-key/components/restrict-api-to-admins.tsx";

export default function WorkspaceApiKeys() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();

  if (!isAdmin) {
    return null;
  }

  return (
    <>
      <DocumentTitle title={t("API management")} />
      <SettingsTitle title={t("API management")} />

      <RestrictApiToAdmins />
      <Divider my="lg" />

      <ApiKeyManager
        adminView
        description={t("Every API key in the workspace. Revoke any key that should no longer have access.")}
      />
    </>
  );
}
