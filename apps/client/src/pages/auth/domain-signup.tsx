import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { Anchor, Box, Button, Container, PasswordInput, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import { domainSignup } from "@/features/auth/services/auth-service";
import APP_ROUTE from "@/lib/app-route";
import { AuthLayout } from "@/features/auth/components/auth-layout";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

// Sign-up without an invitation, for emails on a verified domain.
export default function DomainSignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: workspace } = useWorkspacePublicDataQuery();
  const [loading, setLoading] = useState(false);
  const domains = workspace?.domainSignup ?? [];
  const form = useForm({
    validate: zod4Resolver(schema),
    initialValues: { name: "", email: "", password: "" },
  });

  const submit = async (values: { name: string; email: string; password: string }) => {
    const domain = values.email.split("@")[1]?.toLowerCase();
    if (domains.length && !domains.includes(domain)) {
      form.setFieldError("email", t("Use an email on one of these domains: {{domains}}", { domains: domains.join(", ") }));
      return;
    }
    setLoading(true);
    try {
      await domainSignup({ ...values, email: values.email.toLowerCase() });
      navigate("/home");
    } catch (err: any) {
      notifications.show({ message: err?.response?.data?.message || t("Could not sign up"), color: "red" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <DocumentTitle title={t("Sign up")} />
      <Container size={420} py={40}>
        <Box>
          <Title order={1} size="h2" ta="center" fw={500} mb="xs">
            {t("Sign up")}
          </Title>
          <Text size="sm" c="dimmed" ta="center" mb="md">
            {domains.length
              ? t("For emails on {{domains}}", { domains: domains.map((d) => `@${d}`).join(", ") })
              : t("Sign-up is not open on this workspace")}
          </Text>
          <form onSubmit={form.onSubmit(submit)}>
            <TextInput label={t("Name")} variant="filled" {...form.getInputProps("name")} data-autofocus />
            <TextInput label={t("Email")} type="email" variant="filled" mt="md" {...form.getInputProps("email")} />
            <PasswordInput label={t("Password")} variant="filled" mt="md" {...form.getInputProps("password")} />
            <Button type="submit" fullWidth mt="md" loading={loading} disabled={domains.length === 0}>
              {t("Create account")}
            </Button>
          </form>
          <Text size="sm" ta="center" mt="md">
            <Anchor component={Link} to={APP_ROUTE.AUTH.LOGIN} size="sm">
              {t("Back to login")}
            </Anchor>
          </Text>
        </Box>
      </Container>
    </AuthLayout>
  );
}
