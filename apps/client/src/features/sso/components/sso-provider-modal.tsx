import { useEffect } from "react";
import { z } from "zod/v4";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import {
  Button,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import CopyTextButton from "@/components/common/copy.tsx";
import {
  ISsoProvider,
  IUpdateSsoProvider,
} from "@/features/sso/types/sso.types.ts";
import { buildOidcCallbackUrl } from "@/features/sso/sso.utils.ts";
import { useUpdateSsoProviderMutation } from "@/features/sso/queries/sso-query.ts";
import classes from "./sso.module.css";

interface SsoProviderModalProps {
  opened: boolean;
  onClose: () => void;
  provider: ISsoProvider | null;
}

type FormValues = {
  name: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  groupSync: boolean;
  allowSignup: boolean;
  isEnabled: boolean;
};

function buildSchema(hasStoredSecret: boolean, t: (key: string) => string) {
  return z
    .object({
      name: z.string().trim().min(1, t("Display name is required")),
      oidcIssuer: z
        .string()
        .trim()
        .url(t("Enter a valid URL"))
        .refine((value) => /^https?:\/\//i.test(value), t("Enter a valid URL")),
      oidcClientId: z.string().trim().min(1, t("Client ID is required")),
      oidcClientSecret: z.string(),
      groupSync: z.boolean(),
      allowSignup: z.boolean(),
      isEnabled: z.boolean(),
    })
    .refine((values) => hasStoredSecret || values.oidcClientSecret.trim().length > 0, {
      message: t("Client secret is required"),
      path: ["oidcClientSecret"],
    });
}

function initialValues(provider: ISsoProvider | null): FormValues {
  return {
    name: provider?.name ?? "",
    oidcIssuer: provider?.oidcIssuer ?? "",
    oidcClientId: provider?.oidcClientId ?? "",
    oidcClientSecret: "",
    groupSync: provider?.groupSync ?? false,
    allowSignup: provider?.allowSignup ?? false,
    isEnabled: provider?.isEnabled ?? false,
  };
}

// Edit one OpenID Connect provider. The stored secret is never shown; leave
// the field empty to keep it.
export default function SsoProviderModal({
  opened,
  onClose,
  provider,
}: SsoProviderModalProps) {
  const { t } = useTranslation();
  const updateMutation = useUpdateSsoProviderMutation();
  const hasStoredSecret = provider?.hasOidcClientSecret ?? false;

  const form = useForm<FormValues>({
    initialValues: initialValues(provider),
    validate: zod4Resolver(buildSchema(hasStoredSecret, t)),
  });

  useEffect(() => {
    if (opened) {
      form.setValues(initialValues(provider));
      form.resetDirty(initialValues(provider));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, provider?.id, provider?.updatedAt]);

  if (!provider) {
    return null;
  }

  const callbackUrl = buildOidcCallbackUrl(provider.id);

  const handleSubmit = async (values: FormValues) => {
    const payload: IUpdateSsoProvider = { providerId: provider.id };
    if (form.isDirty("name")) payload.name = values.name.trim();
    if (form.isDirty("oidcIssuer")) payload.oidcIssuer = values.oidcIssuer.trim();
    if (form.isDirty("oidcClientId")) payload.oidcClientId = values.oidcClientId.trim();
    if (values.oidcClientSecret.trim()) {
      payload.oidcClientSecret = values.oidcClientSecret.trim();
    }
    if (form.isDirty("groupSync")) payload.groupSync = values.groupSync;
    if (form.isDirty("allowSignup")) payload.allowSignup = values.allowSignup;
    if (form.isDirty("isEnabled")) payload.isEnabled = values.isEnabled;

    try {
      await updateMutation.mutateAsync(payload);
      onClose();
    } catch {
      // The mutation already showed the server's message.
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("OpenID Connect provider")}
      size="lg"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label={t("Display name")}
            description={t("Shown on the login button")}
            placeholder={t("e.g Company login")}
            data-autofocus
            {...form.getInputProps("name")}
          />

          <TextInput
            label={t("Callback URL")}
            description={t("Register this redirect URI with your identity provider")}
            variant="filled"
            value={callbackUrl}
            readOnly
            rightSection={<CopyTextButton text={callbackUrl} />}
          />

          <TextInput
            label={t("Issuer URL")}
            description={t("The base URL that serves /.well-known/openid-configuration")}
            placeholder="https://auth.example.com"
            {...form.getInputProps("oidcIssuer")}
          />

          <TextInput
            label={t("Client ID")}
            placeholder="docmore"
            {...form.getInputProps("oidcClientId")}
          />

          <PasswordInput
            label={t("Client secret")}
            description={
              hasStoredSecret
                ? t("A secret is stored. Leave empty to keep it.")
                : t("Issued by your identity provider")
            }
            placeholder={hasStoredSecret ? "••••••••••••" : ""}
            autoComplete="new-password"
            {...form.getInputProps("oidcClientSecret")}
          />

          <div className={classes.switchRow}>
            <div>
              <Text size="sm">{t("Allow signup")}</Text>
              <Text size="xs" c="dimmed">
                {t("Create an account on first sign-in when the email is new here")}
              </Text>
            </div>
            <Switch
              checked={form.values.allowSignup}
              onChange={(event) =>
                form.setFieldValue("allowSignup", event.currentTarget.checked)
              }
              aria-label={t("Allow signup")}
            />
          </div>

          <div className={classes.switchRow}>
            <div>
              <Text size="sm">{t("Group sync")}</Text>
              <Text size="xs" c="dimmed">
                {t("Join the groups listed in the provider's groups claim on each sign-in")}
              </Text>
            </div>
            <Switch
              checked={form.values.groupSync}
              onChange={(event) =>
                form.setFieldValue("groupSync", event.currentTarget.checked)
              }
              aria-label={t("Group sync")}
            />
          </div>

          <div className={classes.switchRow}>
            <div>
              <Text size="sm">{t("Enabled")}</Text>
              <Text size="xs" c="dimmed">
                {t("Show this provider on the login page")}
              </Text>
            </div>
            <Switch
              checked={form.values.isEnabled}
              onChange={(event) =>
                form.setFieldValue("isEnabled", event.currentTarget.checked)
              }
              aria-label={t("Enabled")}
            />
          </div>

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              loading={updateMutation.isPending}
              disabled={!form.isDirty() && !form.values.oidcClientSecret}
            >
              {t("Save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
