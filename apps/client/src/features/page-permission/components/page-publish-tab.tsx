import { useEffect, useState } from "react";
import { ActionIcon, Anchor, Group, Stack, Switch, Text, TextInput } from "@mantine/core";
import { IconExternalLink, IconLock } from "@tabler/icons-react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import CopyTextButton from "@/components/common/copy";
import { getPageIcon } from "@/lib";
import { getAppUrl } from "@/lib/config";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  useCreateShareMutation,
  useDeleteShareMutation,
  useShareForPageQuery,
  useUpdateShareMutation,
} from "@/features/share/queries/share-query";
import { ShareProtectionControls } from "@/features/share/components/share-protection-controls";

interface PagePublishTabProps {
  pageId: string;
  readOnly?: boolean;
  isRestricted: boolean;
  sharingDisabledReason?: string;
}

function Blocked({ title, detail }: { title: string; detail: string }) {
  return (
    <Stack align="center" py="md" gap={4}>
      <IconLock size={20} stroke={1.5} />
      <Text size="sm" fw={500} ta="center">
        {title}
      </Text>
      <Text size="sm" c="dimmed" ta="center">
        {detail}
      </Text>
    </Stack>
  );
}

// Public link for the page, built on the share endpoints Docmost already has.
export function PagePublishTab({ pageId, readOnly, isRestricted, sharingDisabledReason }: PagePublishTabProps) {
  const { t } = useTranslation();
  const { pageSlug, spaceSlug } = useParams();
  const { data: share } = useShareForPageQuery(pageId);
  const createShare = useCreateShareMutation();
  const updateShare = useUpdateShareMutation();
  const deleteShare = useDeleteShareMutation();
  const [isPublic, setIsPublic] = useState(false);

  useEffect(() => {
    setIsPublic(!!share);
  }, [share, pageId]);

  if (sharingDisabledReason) {
    return <Blocked title={t("Public sharing is off")} detail={sharingDisabledReason} />;
  }
  if (isRestricted) {
    return (
      <Blocked
        title={t("Restricted page")}
        detail={t("A page with restricted access cannot be published to the web.")}
      />
    );
  }

  const sharedHere = share && share.level === 0;
  const sharedByParent = share && share.level > 0;
  const publicLink = `${getAppUrl()}/share/${share?.key}/p/${pageSlug}`;

  const togglePublic = async (value: boolean) => {
    setIsPublic(value);
    try {
      if (value) {
        await createShare.mutateAsync({ pageId, includeSubPages: true, searchIndexing: false });
      } else if (share?.id) {
        await deleteShare.mutateAsync(share.id);
      }
    } catch {
      setIsPublic(!value);
    }
  };

  const linkRow = (
    <Group gap={4} wrap="nowrap">
      <TextInput
        variant="filled"
        value={publicLink}
        readOnly
        rightSection={<CopyTextButton text={publicLink} />}
        style={{ flex: 1 }}
      />
      <ActionIcon component="a" variant="default" target="_blank" href={publicLink} aria-label={t("Open public link")}>
        <IconExternalLink size={16} />
      </ActionIcon>
    </Group>
  );

  if (sharedByParent) {
    return (
      <Stack gap="sm">
        <Text size="sm">{t("Published together with")}</Text>
        <Anchor
          component={Link}
          to={buildPageUrl(spaceSlug, share.sharedPage.slugId, share.sharedPage.title)}
          underline="never"
          style={{ color: "var(--mantine-color-text)" }}
        >
          <Group gap={4} wrap="nowrap">
            {getPageIcon(share.sharedPage.icon)}
            <Text fz="sm" fw={500} lineClamp={1}>
              {share.sharedPage.title || t("Untitled")}
            </Text>
          </Group>
        </Anchor>
        {linkRow}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">{isPublic ? t("Published to the web") : t("Publish to the web")}</Text>
          <Text size="xs" c="dimmed">
            {isPublic ? t("Anyone with the link can read this page.") : t("Create a public, read-only link.")}
          </Text>
        </div>
        <Switch
          checked={isPublic}
          onChange={(event) => togglePublic(event.currentTarget.checked)}
          disabled={readOnly}
          size="xs"
          aria-label={t("Toggle publish to the web")}
        />
      </Group>

      {sharedHere && (
        <>
          {linkRow}
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Include subpages")}</Text>
              <Text size="xs" c="dimmed">
                {t("Pages under this one are public too.")}
              </Text>
            </div>
            <Switch
              checked={share.includeSubPages}
              onChange={(event) =>
                updateShare.mutate({ shareId: share.id, includeSubPages: event.currentTarget.checked })
              }
              disabled={readOnly}
              size="xs"
              aria-label={t("Toggle include subpages")}
            />
          </Group>
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Search engine indexing")}</Text>
              <Text size="xs" c="dimmed">
                {t("Let search engines list this page.")}
              </Text>
            </div>
            <Switch
              checked={share.searchIndexing}
              onChange={(event) =>
                updateShare.mutate({ shareId: share.id, searchIndexing: event.currentTarget.checked })
              }
              disabled={readOnly}
              size="xs"
              aria-label={t("Toggle search engine indexing")}
            />
          </Group>
          <ShareProtectionControls share={share} readOnly={readOnly} />
        </>
      )}
    </Stack>
  );
}
