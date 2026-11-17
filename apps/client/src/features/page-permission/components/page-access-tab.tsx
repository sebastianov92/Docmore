import { useState } from "react";
import { Box, Button, Divider, Group, Paper, Select, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconArrowRight, IconShieldLock } from "@tabler/icons-react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MultiMemberSelect } from "@/features/space/components/multi-member-select";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  useAddPagePermissionMutation,
  useRestrictPageMutation,
  useUnrestrictPageMutation,
} from "@/features/page-permission/queries/page-permission-query.ts";
import {
  IPageRestrictionInfo,
  PagePermissionRole,
} from "@/features/page-permission/types/page-permission.types.ts";
import { AccessLevel, AccessLevelPicker } from "./access-level-picker.tsx";
import { PageAccessMembers } from "./page-access-members.tsx";
import { ROLE_OPTIONS } from "./page-access-member-row.tsx";
import classes from "./page-access.module.css";

interface PageAccessTabProps {
  pageId: string;
  info: IPageRestrictionInfo;
}

export function PageAccessTab({ pageId, info }: PageAccessTabProps) {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<PagePermissionRole>("writer");

  const restrictMutation = useRestrictPageMutation();
  const unrestrictMutation = useUnrestrictPageMutation();
  const addMutation = useAddPagePermissionMutation();

  const { hasDirectRestriction, hasInheritedRestriction } = info;
  const canManage = info.userAccess.canManage;

  const changeLevel = (level: AccessLevel) => {
    if (level === "restricted" && !hasDirectRestriction) {
      restrictMutation.mutate(pageId);
    } else if (level === "open" && hasDirectRestriction) {
      unrestrictMutation.mutate(pageId);
    }
  };

  // MultiMemberSelect reports "user-<id>" and "group-<id>" values.
  const addPicked = async () => {
    const userIds = picked.filter((id) => id.startsWith("user-")).map((id) => id.slice(5));
    const groupIds = picked.filter((id) => id.startsWith("group-")).map((id) => id.slice(6));
    if (userIds.length === 0 && groupIds.length === 0) return;
    try {
      await addMutation.mutateAsync({
        pageId,
        role,
        ...(userIds.length ? { userIds } : {}),
        ...(groupIds.length ? { groupIds } : {}),
      });
      setPicked([]);
    } catch {
      // the mutation already showed the error
    }
  };

  return (
    <Stack gap="md">
      {hasInheritedRestriction && info.inheritedFrom && (
        <Paper className={classes.inherited} p="sm" radius="md">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size="lg" radius="sm" variant="light" color="orange">
              <IconShieldLock size={18} stroke={1.5} />
            </ThemeIcon>
            <Box style={{ flex: 1 }}>
              <Text size="sm" fw={500}>
                {t("Access is limited by a parent page")}
              </Text>
              <Link
                to={buildPageUrl(spaceSlug, info.inheritedFrom.slugId, info.inheritedFrom.title ?? "")}
                style={{ textDecoration: "none" }}
              >
                <Group gap={2}>
                  <Text size="xs" fw={500} c="blue">
                    {info.inheritedFrom.title || t("Untitled")}
                  </Text>
                  <IconArrowRight size={12} color="var(--mantine-color-blue-6)" />
                </Group>
              </Link>
            </Box>
          </Group>
        </Paper>
      )}

      <AccessLevelPicker
        value={hasDirectRestriction ? "restricted" : "open"}
        inherited={hasInheritedRestriction}
        disabled={!canManage || restrictMutation.isPending || unrestrictMutation.isPending}
        onChange={changeLevel}
      />

      {hasDirectRestriction && (
        <>
          <Divider />

          {canManage && (
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <MultiMemberSelect value={picked} onChange={setPicked} />
              </Box>
              <Select
                data={ROLE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
                value={role}
                onChange={(value) => value && setRole(value as PagePermissionRole)}
                allowDeselect={false}
                variant="filled"
                w={130}
                comboboxProps={{ withinPortal: true }}
                aria-label={t("Role for new people")}
              />
              <Button onClick={addPicked} disabled={picked.length === 0} loading={addMutation.isPending}>
                {t("Add")}
              </Button>
            </Group>
          )}

          <PageAccessMembers
            pageId={pageId}
            canManage={canManage}
            onRemoveAll={() => unrestrictMutation.mutate(pageId)}
          />
        </>
      )}
    </Stack>
  );
}
