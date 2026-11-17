import { useEffect, useRef } from "react";
import { Center, Group, Loader, ScrollArea, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import {
  usePageAccessMembersQuery,
  useRemovePagePermissionMutation,
  useUpdatePagePermissionMutation,
} from "@/features/page-permission/queries/page-permission-query.ts";
import {
  IPagePermissionMember,
  PagePermissionRole,
} from "@/features/page-permission/types/page-permission.types.ts";
import { PageAccessMemberRow } from "./page-access-member-row.tsx";
import classes from "./page-access.module.css";

interface PageAccessMembersProps {
  pageId: string;
  canManage: boolean;
  onRemoveAll: () => void;
}

export function PageAccessMembers({ pageId, canManage, onRemoveAll }: PageAccessMembersProps) {
  const { t } = useTranslation();
  const currentUser = useAtomValue(userAtom);
  const updateMutation = useUpdatePagePermissionMutation();
  const removeMutation = useRemovePagePermissionMutation();
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    usePageAccessMembersQuery(pageId);

  const sentinel = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { root: viewport.current, threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const members = data?.pages.flatMap((page) => page.items) ?? [];
  // You first, then groups, then people.
  const ordered = [...members].sort((a, b) => {
    const rank = (member: IPagePermissionMember) =>
      member.type === "user" && member.id === currentUser?.id ? 0 : member.type === "group" ? 1 : 2;
    return rank(a) - rank(b);
  });

  const changeRole = (member: IPagePermissionMember, role: PagePermissionRole) => {
    if (member.role === role) return;
    updateMutation.mutate({
      pageId,
      role,
      ...(member.type === "user" ? { userId: member.id } : { groupId: member.id }),
    });
  };

  const confirmRemove = (member: IPagePermissionMember) => {
    modals.openConfirmModal({
      title: t("Remove access"),
      centered: true,
      children: (
        <Text size="sm">
          {t("{{name}} will no longer be able to open this page or anything under it.", {
            name: member.name,
          })}
        </Text>
      ),
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () =>
        removeMutation.mutate({
          pageId,
          ...(member.type === "user" ? { userIds: [member.id] } : { groupIds: [member.id] }),
        }),
    });
  };

  const confirmRemoveAll = () => {
    modals.openConfirmModal({
      title: t("Open the page to the space"),
      centered: true,
      children: (
        <Text size="sm">
          {t("The list below is dropped and everyone with access to the space can open the page again.")}
        </Text>
      ),
      labels: { confirm: t("Open to the space"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: onRemoveAll,
    });
  };

  if (isLoading) {
    return (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    );
  }

  if (members.length === 0) {
    return null;
  }

  return (
    <>
      <Group justify="space-between" align="center">
        <Text size="sm" fw={500}>
          {t("Who has access")}
        </Text>
        {canManage && (
          <Text className={classes.removeAll} onClick={confirmRemoveAll} role="button">
            {t("Remove all")}
          </Text>
        )}
      </Group>

      <ScrollArea.Autosize mah={360} viewportRef={viewport}>
        {ordered.map((member) => (
          <PageAccessMemberRow
            key={`${member.type}-${member.id}`}
            member={member}
            canManage={canManage}
            onRoleChange={changeRole}
            onRemove={confirmRemove}
          />
        ))}
        <div ref={sentinel} style={{ height: 1 }} />
        {isFetchingNextPage && (
          <Center py="xs">
            <Loader size="xs" />
          </Center>
        )}
      </ScrollArea.Autosize>
    </>
  );
}
