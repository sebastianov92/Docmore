import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Code, Group, Menu, Modal, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { IconKey, IconLockOff, IconLogout, IconMailForward, IconUserEdit, IconLock } from "@tabler/icons-react";
import CopyTextButton from "@/components/common/copy.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { getApiErrorMessage } from "@/lib/api-error";
import { resetMemberPassword, setMemberPassword, setMemberPasswordLogin, signOutMember, updateMemberProfile } from "@/features/workspace/services/workspace-service";

type Props = {
  userId: string;
  name: string;
  email: string;
  role: string;
  passwordLoginLocked?: boolean;
};

// Menu items for an admin acting on someone else's account, plus the
// modals they open: profile, sign-out everywhere, password reset / set,
// and the SSO-only switch.
export function ManagedUserActions({ userId, name, email, role, passwordLoginLocked }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { isOwner } = useUserRole();
  const [profile, setProfile] = useState<{ name: string; email: string } | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["workspaceMembers"] });
  const fail = (err: unknown) => notifications.show({ color: "red", message: getApiErrorMessage(err) });
  const ownerTarget = role === "owner" && !isOwner;

  const saveProfile = async () => {
    if (!profile) return;
    setBusy(true);
    try {
      await updateMemberProfile({ userId, name: profile.name, email: profile.email });
      notifications.show({ message: t("Profile updated") });
      setProfile(null);
      refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () =>
    modals.openConfirmModal({
      title: t("Sign out everywhere"),
      children: <Text size="sm">{t("{{name}} will be signed out of every device and browser.", { name })}</Text>,
      labels: { confirm: t("Sign out"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: async () => {
        try {
          await signOutMember({ userId });
          notifications.show({ message: t("Signed out everywhere") });
        } catch (err) {
          fail(err);
        }
      },
    });

  const sendReset = async () => {
    try {
      const r = await resetMemberPassword({ userId });
      if (r.link) setResetLink(r.link);
      else notifications.show({ message: r.sent ? t("Reset email sent") : t("Reset created, but the email could not be sent") });
    } catch (err) {
      fail(err);
    }
  };

  const setTemp = () => {
    const generated = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 54]).join("");
    modals.openConfirmModal({
      title: t("Set a temporary password"),
      children: <Text size="sm">{t("{{name}} gets this password and is signed out everywhere. Share it with them safely.", { name })}</Text>,
      labels: { confirm: t("Set password"), cancel: t("Cancel") },
      onConfirm: async () => {
        try {
          await setMemberPassword({ userId, password: generated });
          setTempPassword(generated);
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  const togglePasswordLogin = async () => {
    try {
      await setMemberPasswordLogin({ userId, locked: !passwordLoginLocked });
      notifications.show({ message: passwordLoginLocked ? t("Password sign-in allowed again") : t("Password sign-in turned off; single sign-on only") });
      refresh();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <Menu.Item leftSection={<IconUserEdit size={16} />} disabled={ownerTarget} onClick={() => setProfile({ name, email })} data-testid="member-edit-profile">
        {t("Edit profile")}
      </Menu.Item>
      <Menu.Item leftSection={<IconLogout size={16} />} disabled={ownerTarget} onClick={signOut}>
        {t("Sign out everywhere")}
      </Menu.Item>
      <Menu.Item leftSection={<IconMailForward size={16} />} disabled={ownerTarget || passwordLoginLocked} onClick={sendReset}>
        {t("Send password reset")}
      </Menu.Item>
      {isOwner && (
        <Menu.Item leftSection={<IconKey size={16} />} onClick={setTemp}>
          {t("Set a temporary password")}
        </Menu.Item>
      )}
      <Menu.Item leftSection={passwordLoginLocked ? <IconLockOff size={16} /> : <IconLock size={16} />} disabled={ownerTarget} onClick={togglePasswordLogin}>
        {passwordLoginLocked ? t("Allow password sign-in") : t("Single sign-on only")}
      </Menu.Item>

      <Modal opened={Boolean(profile)} onClose={() => setProfile(null)} title={t("Edit profile")} size="sm">
        {profile && (
          <Stack gap="sm">
            <TextInput label={t("Name")} value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.currentTarget.value })} data-autofocus />
            <TextInput label={t("Email")} type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.currentTarget.value })} />
            <Group justify="flex-end">
              <Button onClick={saveProfile} loading={busy} disabled={!profile.name.trim() || !profile.email.trim()}>
                {t("Save")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <Modal opened={Boolean(resetLink)} onClose={() => setResetLink(null)} title={t("Password reset link")} size="md">
        <Stack gap="sm">
          <Text size="sm">{t("The email was queued too. This link works once, for 30 minutes.")}</Text>
          <Group gap="xs" wrap="nowrap">
            <Code style={{ wordBreak: "break-all" }}>{resetLink}</Code>
            {resetLink && <CopyTextButton text={resetLink} />}
          </Group>
        </Stack>
      </Modal>
      <Modal opened={Boolean(tempPassword)} onClose={() => setTempPassword(null)} title={t("Temporary password")} size="sm">
        <Stack gap="sm">
          <Text size="sm">{t("Shown once. The member should change it after signing in.")}</Text>
          <Group gap="xs" wrap="nowrap">
            <PasswordInput value={tempPassword ?? ""} readOnly style={{ flex: 1 }} visible />
            {tempPassword && <CopyTextButton text={tempPassword} />}
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
