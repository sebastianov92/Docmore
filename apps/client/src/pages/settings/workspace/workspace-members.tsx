import WorkspaceInviteModal from "@/features/workspace/components/members/components/workspace-invite-modal";
import { Group, SegmentedControl, Space, Text } from "@mantine/core";
import WorkspaceMembersTable from "@/features/workspace/components/members/components/workspace-members-table";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import WorkspaceInvitesTable from "@/features/workspace/components/members/components/workspace-invites-table.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import InviteRequestsTable from "@/features/workspace/components/members/components/invite-requests-table";
import RequestInviteModal from "@/features/workspace/components/members/components/request-invite-modal";
import { useInviteRequestsQuery } from "@/features/workspace/queries/workspace-query.ts";

export default function WorkspaceMembers() {
  const { t } = useTranslation();
  const [segmentValue, setSegmentValue] = useState("members");
  const [workspace] = useAtom(workspaceAtom);
  const [searchParams] = useSearchParams();
  const { isAdmin } = useUserRole();
  const navigate = useNavigate();
  const { data: requestsData } = useInviteRequestsQuery(isAdmin);
  const requestCount = requestsData?.items?.length ?? 0;

  useEffect(() => {
    const currentTab = searchParams.get("tab");
    if (currentTab === "invites" || currentTab === "requests") {
      setSegmentValue(currentTab);
    }
  }, [searchParams.get("tab")]);

  const handleSegmentChange = (value: string) => {
    setSegmentValue(value);
    if (value === "invites" || value === "requests") {
      navigate(`?tab=${value}`);
    } else {
      navigate("");
    }
  };

  return (
    <>
      <DocumentTitle title={t("Members")} />
      <SettingsTitle title={t("Members")} />

      {/* <WorkspaceInviteSection /> */}
      {/* <Divider my="lg" /> */}

      <Group justify="space-between">
        <SegmentedControl
          value={segmentValue}
          onChange={handleSegmentChange}
          data={[
            {
              label: t("Members") + ` (${workspace?.memberCount})`,
              value: "members",
            },
            { label: t("Pending"), value: "invites" },
            ...(isAdmin
              ? [
                  {
                    label:
                      t("Requests") +
                      (requestCount ? ` (${requestCount})` : ""),
                    value: "requests",
                  },
                ]
              : []),
          ]}
          withItemsBorders={false}
        />

        {isAdmin ? <WorkspaceInviteModal /> : <RequestInviteModal />}
      </Group>

      <Space h="lg" />

      {segmentValue === "requests" && isAdmin ? (
        <InviteRequestsTable />
      ) : segmentValue === "invites" ? (
        <WorkspaceInvitesTable />
      ) : (
        <WorkspaceMembersTable />
      )}
    </>
  );
}
