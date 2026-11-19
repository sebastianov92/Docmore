import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Anchor,
  Button,
  Group,
  Menu,
  PasswordInput,
  Switch,
  Text,
} from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useUpdateShareMutation } from "@/features/share/queries/share-query";
import { IShare } from "@/features/share/types/share.types";

interface Props {
  share: Pick<IShare, "id" | "hasPassword" | "expiresAt">;
  readOnly?: boolean;
}

// Password and expiry rows of a share. The switch opens the input; saving
// sends the password, turning the switch off clears it. The hash never
// reaches the client, only `hasPassword`.
export function ShareProtectionControls({ share, readOnly }: Props) {
  const { t } = useTranslation();
  const updateShare = useUpdateShareMutation();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");

  useEffect(() => {
    setPasswordOpen(false);
    setPasswordDraft("");
  }, [share.id]);

  const handlePasswordToggle = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = event.currentTarget.checked;
    if (value) {
      setPasswordOpen(true);
      return;
    }
    setPasswordOpen(false);
    setPasswordDraft("");
    if (share.hasPassword) {
      try {
        await updateShare.mutateAsync({ shareId: share.id, password: null });
      } catch {
        // query invalidation will revert the UI
      }
    }
  };

  const savePassword = async () => {
    const password = passwordDraft.trim();
    if (password.length < 4) return;
    try {
      await updateShare.mutateAsync({ shareId: share.id, password });
      setPasswordOpen(false);
      setPasswordDraft("");
    } catch {
      // the mutation shows the error
    }
  };

  const expiryPresets: { label: string; days: number | null }[] = [
    { label: t("Never"), days: null },
    { label: t("In 1 day"), days: 1 },
    { label: t("In 7 days"), days: 7 },
    { label: t("In 30 days"), days: 30 },
    { label: t("In 90 days"), days: 90 },
  ];
  const setExpiry = async (days: number | null) => {
    const expiresAt =
      days === null
        ? null
        : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    try {
      await updateShare.mutateAsync({ shareId: share.id, expiresAt });
    } catch {
      // query invalidation will revert the UI
    }
  };
  const expiresAt = share.expiresAt ? new Date(share.expiresAt) : null;
  const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
  const expiryLabel = !expiresAt
    ? t("Never")
    : expired
      ? t("Expired")
      : expiresAt.toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        });

  return (
    <>
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">{t("Password protection")}</Text>
          <Text size="xs" c="dimmed">
            {t("Readers must enter a password")}
          </Text>
        </div>
        <Switch
          onChange={handlePasswordToggle}
          checked={Boolean(share.hasPassword) || passwordOpen}
          size="xs"
          disabled={readOnly}
          aria-label={t("Toggle password protection")}
        />
      </Group>
      {passwordOpen ? (
        <Group gap={4} wrap="nowrap">
          <PasswordInput
            size="xs"
            style={{ flex: 1 }}
            placeholder={t("At least 4 characters")}
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                savePassword();
              }
            }}
            autoFocus
            data-testid="share-password-input"
          />
          <Button
            size="xs"
            onClick={savePassword}
            disabled={passwordDraft.trim().length < 4}
            loading={updateShare.isPending}
          >
            {t("Save")}
          </Button>
        </Group>
      ) : share.hasPassword && !readOnly ? (
        <Anchor
          size="xs"
          component="button"
          type="button"
          onClick={() => setPasswordOpen(true)}
        >
          {t("Change password")}
        </Anchor>
      ) : null}
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">{t("Link expires")}</Text>
          <Text size="xs" c={expired ? "red" : "dimmed"}>
            {expired
              ? t("This link no longer opens")
              : t("Stops working after the chosen date")}
          </Text>
        </div>
        <Menu shadow="md" width={160} position="bottom-end">
          <Menu.Target>
            <Button
              size="compact-xs"
              variant="default"
              disabled={readOnly}
              rightSection={<IconChevronDown size={12} />}
              c={expired ? "red" : undefined}
              aria-label={t("Link expires")}
            >
              {expiryLabel}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {expiryPresets.map((preset) => (
              <Menu.Item
                key={preset.label}
                onClick={() => setExpiry(preset.days)}
              >
                {preset.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
    </>
  );
}
