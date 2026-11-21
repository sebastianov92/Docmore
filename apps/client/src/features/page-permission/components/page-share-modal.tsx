import { useConnectivity } from "@/lib/offline/connectivity.ts";
import { useState } from "react";
import { Button, Center, Indicator, Loader, Modal, Tabs } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLock, IconWorld } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { extractPageSlugId } from "@/lib";
import { usePageQuery } from "@/features/page/queries/page-query";
import { useShareForPageQuery } from "@/features/share/queries/share-query";
import { useSpaceQuery } from "@/features/space/queries/space-query";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { usePageRestrictionQuery } from "@/features/page-permission/queries/page-permission-query.ts";
import { PageAccessTab } from "./page-access-tab.tsx";
import { PagePublishTab } from "./page-publish-tab.tsx";

interface PageShareModalProps {
  readOnly?: boolean;
}

// The Share button in the page header: who can open the page, and the public link.
export function PageShareModal({ readOnly }: PageShareModalProps) {
  const { t } = useTranslation();
  const { online } = useConnectivity();
  const { pageSlug, spaceSlug } = useParams();
  const [opened, { open, close }] = useDisclosure(false);
  const [tab, setTab] = useState<string | null>("access");

  const workspace = useAtomValue(workspaceAtom);
  const { data: space } = useSpaceQuery(spaceSlug);
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const pageId = page?.id;
  const isRestricted = page?.permissions?.hasRestriction ?? false;

  const { data: share } = useShareForPageQuery(pageId);
  const isPublic = !!share;

  const { data: info, isLoading: infoLoading } = usePageRestrictionQuery(opened ? pageId : undefined);

  const sharingDisabledReason =
    workspace?.settings?.sharing?.disabled === true
      ? t("Public sharing is turned off for the whole workspace.")
      : space?.settings?.sharing?.disabled === true
        ? t("Public sharing is turned off for this space.")
        : undefined;

  return (
    <>
      <Button
        style={{ border: "none" }}
        size="compact-sm"
        variant="default"
        leftSection={
          isRestricted ? (
            <Indicator color="red" offset={5} withBorder>
              <IconLock size={20} stroke={1.5} />
            </Indicator>
          ) : isPublic ? (
            <Indicator color="green" offset={5} withBorder>
              <IconWorld size={20} stroke={1.5} />
            </Indicator>
          ) : null
        }
        // sharing is decided on the server
        disabled={!online}
        title={online ? undefined : t("This needs a connection to the server")}
        onClick={() => {
          setTab(isPublic && !isRestricted ? "publish" : "access");
          open();
        }}
      >
        {t("Share")}
      </Button>

      <Modal
        opened={opened}
        onClose={close}
        title={t("Share")}
        size={600}
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <Tabs value={tab} color="dark" onChange={setTab}>
          <Tabs.List mb="md">
            <Tabs.Tab value="access">{t("Access")}</Tabs.Tab>
            <Tabs.Tab
              value="publish"
              rightSection={isPublic ? <Indicator color="green" size={8} processing /> : null}
            >
              {t("Publish")}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="access">
            {infoLoading || !pageId || !info ? (
              <Center py="xl">
                <Loader size="sm" />
              </Center>
            ) : (
              <PageAccessTab pageId={pageId} info={info} />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="publish">
            {pageId && (
              <PagePublishTab
                pageId={pageId}
                readOnly={readOnly}
                isRestricted={isRestricted}
                sharingDisabledReason={sharingDisabledReason}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </Modal>
    </>
  );
}
