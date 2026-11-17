import { useState } from "react";
import { Button, Group, TagsInput, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";

function sameDomains(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// Which email domains may create an account through single sign-on. Empty
// means any domain the identity provider vouches for.
export default function AllowedDomainsSetting() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const saved = workspace?.emailDomains ?? [];
  const [domains, setDomains] = useState<string[]>(saved);
  const [saving, setSaving] = useState(false);

  const dirty = !sameDomains(domains, saved);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateWorkspace({ emailDomains: domains });
      setWorkspace(updated);
      setDomains(updated.emailDomains ?? []);
      notifications.show({ message: t("Updated successfully") });
    } catch (err) {
      notifications.show({
        message: (err as any)?.response?.data?.message,
        color: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Text size="md">{t("Allowed email domains")}</Text>
      <Text size="sm" c="dimmed">
        {t("Only users with email addresses from these domains can signup via SSO.")}
      </Text>
      <TagsInput
        mt="sm"
        description={t("Enter valid domain names separated by comma or space")}
        placeholder={t("e.g acme.com")}
        variant="filled"
        splitChars={[",", " "]}
        maxDropdownHeight={0}
        maxTags={20}
        value={domains}
        onChange={(value) =>
          setDomains(value.map((d) => d.trim().toLowerCase().replace(/^@/, "")))
        }
        aria-label={t("Allowed email domains")}
      />
      <Group justify="flex-end" mt="sm">
        <Button onClick={handleSave} disabled={!dirty} loading={saving}>
          {t("Save")}
        </Button>
      </Group>
    </div>
  );
}
