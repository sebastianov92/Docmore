import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { ApiKeyManager } from "@/features/api-key/components/api-key-manager.tsx";

export default function UserApiKeys() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle title={t("API keys")} />
      <SettingsTitle title={t("API keys")} />
      <ApiKeyManager
        description={t(
          "Keys for your scripts and integrations. Each one acts with your permissions, so keep them private.",
        )}
      />
    </>
  );
}
