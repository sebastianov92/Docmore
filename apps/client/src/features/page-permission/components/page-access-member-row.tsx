import { Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { AutoTooltipText } from "@/components/ui/auto-tooltip-text";
import { IconGroupCircle } from "@/components/icons/icon-people-circle";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { formatMemberCount } from "@/lib/utils.tsx";
import {
  IPagePermissionMember,
  PagePermissionRole,
} from "@/features/page-permission/types/page-permission.types.ts";
import classes from "./page-access.module.css";

export const ROLE_OPTIONS: { value: PagePermissionRole; label: string; detail: string }[] = [
  { value: "writer", label: "Can edit", detail: "Edits the page and manages who has access." },
  { value: "reader", label: "Can view", detail: "Reads the page only." },
];

export function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

interface PageAccessMemberRowProps {
  member: IPagePermissionMember;
  canManage: boolean;
  onRoleChange: (member: IPagePermissionMember, role: PagePermissionRole) => void;
  onRemove: (member: IPagePermissionMember) => void;
}

export function PageAccessMemberRow({ member, canManage, onRoleChange, onRemove }: PageAccessMemberRowProps) {
  const { t } = useTranslation();
  const currentUser = useAtomValue(userAtom);
  const isSelf = member.type === "user" && member.id === currentUser?.id;

  return (
    <div className={classes.memberRow}>
      <div className={classes.memberInfo}>
        {member.type === "user" ? (
          <CustomAvatar avatarUrl={member.avatarUrl} name={member.name} />
        ) : (
          <IconGroupCircle />
        )}
        <div className={classes.memberText}>
          <AutoTooltipText fz="sm" fw={500} tooltipLabel={member.name}>
            {member.name}
            {isSelf && (
              <Text span c="dimmed">
                {" "}
                ({t("You")})
              </Text>
            )}
          </AutoTooltipText>
          <AutoTooltipText fz="xs" c="dimmed">
            {member.type === "user" ? member.email : formatMemberCount(member.memberCount, t)}
          </AutoTooltipText>
        </div>
      </div>

      {canManage ? (
        <Menu position="bottom-end" width={240} withinPortal>
          <Menu.Target>
            <UnstyledButton aria-label={t("Change access for {{name}}", { name: member.name })}>
              <Group gap={4} wrap="nowrap">
                <Text size="sm">{t(roleLabel(member.role))}</Text>
                <IconChevronDown size={14} />
              </Group>
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            {ROLE_OPTIONS.map((option) => (
              <Menu.Item
                key={option.value}
                onClick={() => onRoleChange(member, option.value)}
                rightSection={option.value === member.role ? <IconCheck size={16} /> : null}
              >
                <Text size="sm">{t(option.label)}</Text>
                <Text size="xs" c="dimmed">
                  {t(option.detail)}
                </Text>
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item color="red" onClick={() => onRemove(member)}>
              {t("Remove access")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : (
        <Text size="sm" c="dimmed">
          {t(roleLabel(member.role))}
        </Text>
      )}
    </div>
  );
}
