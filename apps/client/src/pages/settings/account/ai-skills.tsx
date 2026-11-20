import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { SkillsPanel } from "@/features/ai/components/skills-panel";

export default function AccountAiSkills() {
  const { t } = useTranslation();
  return (
    <>
      <DocumentTitle title={t("My skills")} />
      <SettingsTitle title={t("My skills")} />
      <SkillsPanel scope="personal" />
    </>
  );
}
