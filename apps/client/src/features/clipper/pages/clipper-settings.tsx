import { useTranslation } from "react-i18next";
import { Anchor, Code, List, Stack, Text, Title } from "@mantine/core";
import SettingsTitle from "@/components/settings/settings-title";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { getAppUrl } from "@/lib/config.ts";
import { bookmarkletCode } from "@/features/clipper/services";

// How to save web pages into Docmore: a bookmarklet, or the browser extension.
export default function ClipperSettings() {
  const { t } = useTranslation();
  const appUrl = getAppUrl();
  return (
    <>
      <DocumentTitle title={t("Web clipper")} />
      <SettingsTitle title={t("Web clipper")} />
      <Stack gap="lg" maw={720}>
        <Stack gap="xs">
          <Title order={4}>{t("Bookmarklet")}</Title>
          <Text size="sm">{t("Drag this link to your bookmarks bar. On any web page, click it: Docmore opens, you pick the space, and the page is saved as a new page.")}</Text>
          <Anchor href={bookmarkletCode(appUrl)} onClick={(e) => e.preventDefault()} draggable fw={600} data-testid="clipper-bookmarklet" style={{ alignSelf: "flex-start", padding: "6px 12px", border: "1px solid var(--mantine-color-default-border)", borderRadius: 8 }}>
            {t("Clip to Docmore")}
          </Anchor>
          <Text size="xs" c="dimmed">{t("The bookmarklet sends only the address; the server fetches the page itself, so it works for public pages.")}</Text>
        </Stack>
        <Stack gap="xs">
          <Title order={4}>{t("Browser extension")}</Title>
          <Text size="sm">{t("The extension clips what you see (including pages behind a login) and your text selection. It lives in the repository under")} <Code>apps/clipper</Code>.</Text>
          <List size="sm" spacing={4}>
            <List.Item>{t("Chrome / Edge / Brave: open chrome://extensions, turn on Developer mode, Load unpacked, choose the apps/clipper folder.")}</List.Item>
            <List.Item>{t("Firefox: about:debugging, This Firefox, Load Temporary Add-on, pick apps/clipper/manifest.json.")}</List.Item>
            <List.Item>{t("In the extension options set the server address")} <Code>{appUrl}</Code> {t("and an API key with write scope from")} <Anchor href="/settings/account/api-keys">{t("API keys")}</Anchor>.</List.Item>
          </List>
        </Stack>
      </Stack>
    </>
  );
}
