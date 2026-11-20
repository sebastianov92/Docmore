import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { McpServersPanel } from "@/features/ai/components/mcp-servers-panel";

export default function AccountMcpServers() {
  const { t } = useTranslation();
  return (
    <>
      <DocumentTitle title={t("My MCP servers")} />
      <SettingsTitle title={t("My MCP servers")} />
      <McpServersPanel scope="personal" />
    </>
  );
}
