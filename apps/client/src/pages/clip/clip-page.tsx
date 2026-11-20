import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Button, Container, Paper, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";
import { clipPage } from "@/features/clipper/services";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { getApiErrorMessage } from "@/lib/api-error";

// Target of the bookmarklet: pick a space, save the page, open it.
export default function ClipPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const url = params.get("u") ?? "";
  const [title, setTitle] = useState(params.get("t") ?? "");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const options = useMemo(() => (spaces?.items ?? []).map((s) => ({ value: s.id, label: s.name })), [spaces]);
  useEffect(() => {
    if (!spaceId && options.length) {
      const last = localStorage.getItem("docmore:clip-space");
      setSpaceId(options.some((o) => o.value === last) ? last : options[0].value);
    }
  }, [options, spaceId]);
  const clip = useMutation({
    mutationFn: () => clipPage({ spaceId: spaceId as string, url, title: title.trim() || undefined }),
    onSuccess: (page) => {
      try {
        localStorage.setItem("docmore:clip-space", page.spaceId);
      } catch {
        /* ignore */
      }
      navigate(buildPageUrl(page.spaceSlug, page.slugId, page.title));
    },
    onError: (err) => notifications.show({ message: getApiErrorMessage(err), color: "red" }),
  });
  return (
    <Container size={520} py={40}>
      <DocumentTitle title={t("Clip to Docmore")} />
      <Paper withBorder p="lg" radius="md" data-testid="clip-page">
        <Title order={3} mb="sm">
          {t("Clip to Docmore")}
        </Title>
        <Stack gap="sm">
          <Text size="sm" c="dimmed" truncate>
            {url || t("No address given")}
          </Text>
          <TextInput label={t("Title")} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <Select label={t("Space")} data={options} value={spaceId} onChange={(v) => setSpaceId(v)} searchable allowDeselect={false} comboboxProps={{ withinPortal: true }} />
          <Button onClick={() => clip.mutate()} loading={clip.isPending} disabled={!url || !spaceId} data-testid="clip-save">
            {t("Save page")}
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
}
