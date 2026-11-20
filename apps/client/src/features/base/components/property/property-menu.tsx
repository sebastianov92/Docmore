import { useState, useCallback, useRef, useEffect } from "react";
import {
  UnstyledButton,
  TextInput,
  Button,
  Stack,
  Text,
  Group,
  ActionIcon,
  Divider,
  ScrollArea,
  Loader,
  Radio,
} from "@mantine/core";
import {
  IconTrash,
  IconPencil,
  IconChevronRight,
  IconSettings,
  IconLock,
  IconSparkles,
} from "@tabler/icons-react";
import {
  IBaseProperty,
  BasePropertyType,
} from "@/features/base/types/base.types";
import { useAtom } from "jotai";
import { propertyMenuCloseRequestAtomFamily } from "@/features/base/atoms/base-atoms";
import {
  useUpdatePropertyMutation,
  useDeletePropertyMutation,
} from "@/features/base/queries/base-property-query";
import { PropertyTypePicker, propertyTypes } from "./property-type-picker";
import { PropertyOptions } from "./property-options";
import {
  conversionWarning,
  NON_USER_TARGET_TYPES,
} from "./conversion-warning";
import { useTranslation } from "react-i18next";
import { isSystemPropertyType } from "@/features/base/hooks/use-base-table";
import cellClasses from "@/features/base/styles/cells.module.css";
import { useBaseQuery } from "@/features/base/queries/base-query";
import { aiFillProperty } from "@/features/base/services/base-service";
import { notifications } from "@mantine/notifications";
import { getApiErrorMessage } from "@/lib/api-error";

type PropertyMenuContentProps = {
  property: IBaseProperty;
  opened: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  pageId: string;
};

type MenuPanel =
  | "main"
  | "rename"
  | "options"
  | "changeType"
  | "confirmTypeChange"
  | "confirmDelete"
  | "confirmDiscard"
  | "visibility";

export function PropertyMenuContent({
  property,
  opened,
  onClose,
  onDirtyChange,
  pageId,
}: PropertyMenuContentProps) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<MenuPanel>("main");
  const [renameValue, setRenameValue] = useState(property.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [optionsDirty, setOptionsDirty] = useState(false);
  const [pendingTargetType, setPendingTargetType] = useState<BasePropertyType | null>(null);
  const pendingActionRef = useRef<"back" | "close" | null>(null);
  const sourcePanelRef = useRef<"rename" | "options" | null>(null);
  const [closeRequest] = useAtom(propertyMenuCloseRequestAtomFamily(pageId)) as unknown as [number];
  const closeRequestRef = useRef(closeRequest);

  const renameDirty = renameValue !== property.name;
  const { data: base } = useBaseQuery(pageId);
  const baseLocked = Boolean(base?.baseLocked);

  const updatePropertyMutation = useUpdatePropertyMutation();
  const deletePropertyMutation = useDeletePropertyMutation();

  useEffect(() => {
    if (opened) {
      setPanel("main");
      setRenameValue(property.name);
      setOptionsDirty(false);
      setPendingTargetType(null);
    }
  }, [opened, property.name]);

  useEffect(() => {
    if (panel === "rename") {
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [panel]);

  const handleOptionsDirtyChange = useCallback((dirty: boolean) => {
    setOptionsDirty(dirty);
  }, []);

  // Single dirty signal to the outside — reflects whichever panel is
  // currently accumulating unsaved work. Keeps rename and options in
  // lockstep with the `propertyMenuDirtyAtomFamily` so the grid-container's
  // outside-click handler and the header's ESC handler both prompt
  // "Unsaved changes" consistently.
  useEffect(() => {
    const dirty =
      (panel === "rename" && renameDirty) ||
      (panel === "options" && optionsDirty);
    onDirtyChange?.(dirty);
  }, [panel, renameDirty, optionsDirty, onDirtyChange]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== property.name) {
      updatePropertyMutation.mutate({
        propertyId: property.id,
        pageId: property.pageId,
        name: trimmed,
      });
    }
  }, [renameValue, property, updatePropertyMutation]);

  const handleRenameAndClose = useCallback(() => {
    commitRename();
    onClose();
  }, [commitRename, onClose]);

  const requestClose = useCallback(() => {
    if (panel === "rename" && renameDirty) {
      sourcePanelRef.current = "rename";
      pendingActionRef.current = "close";
      setPanel("confirmDiscard");
    } else if (panel === "options" && optionsDirty) {
      sourcePanelRef.current = "options";
      pendingActionRef.current = "close";
      setPanel("confirmDiscard");
    } else {
      onClose();
    }
  }, [panel, renameDirty, optionsDirty, onClose]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameAndClose();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    },
    [handleRenameAndClose, requestClose],
  );

  const handleOptionsUpdate = useCallback(
    (typeOptions: Record<string, unknown>) => {
      updatePropertyMutation.mutate({
        propertyId: property.id,
        pageId: property.pageId,
        typeOptions,
      });
      setOptionsDirty(false);
    },
    [property, updatePropertyMutation],
  );

  const handleTypeSelect = useCallback(
    (type: BasePropertyType) => {
      if (type === property.type) {
        onClose();
        return;
      }
      setPendingTargetType(type);
      setPanel("confirmTypeChange");
    },
    [property.type, onClose],
  );

  const handleApplyTypeChange = useCallback(() => {
    if (!pendingTargetType) return;
    updatePropertyMutation.mutate({
      propertyId: property.id,
      pageId: property.pageId,
      type: pendingTargetType,
      typeOptions: {},
    });
    onClose();
  }, [
    pendingTargetType,
    property.id,
    property.pageId,
    updatePropertyMutation,
    onClose,
  ]);

  const handleDelete = useCallback(() => {
    deletePropertyMutation.mutate({
      propertyId: property.id,
      pageId: property.pageId,
    });
    onClose();
  }, [property, deletePropertyMutation, onClose]);

  const handleOptionsBack = useCallback(() => {
    if (optionsDirty) {
      sourcePanelRef.current = "options";
      pendingActionRef.current = "back";
      setPanel("confirmDiscard");
    } else {
      setPanel("main");
    }
  }, [optionsDirty]);

  useEffect(() => {
    if (closeRequest !== closeRequestRef.current) {
      closeRequestRef.current = closeRequest;
      if (opened) {
        requestClose();
      }
    }
  }, [closeRequest, opened, requestClose]);

  const handleConfirmDiscard = useCallback(() => {
    setOptionsDirty(false);
    setRenameValue(property.name);
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    sourcePanelRef.current = null;
    if (action === "back") {
      setPanel("main");
    } else {
      onClose();
    }
  }, [property.name, onClose]);

  const handleCancelDiscard = useCallback(() => {
    const source = sourcePanelRef.current ?? "options";
    pendingActionRef.current = null;
    sourcePanelRef.current = null;
    setPanel(source);
  }, []);

  return (
    <>
      {panel === "main" && baseLocked && (
        <Stack gap={4} p="sm">
          <Group gap={6} wrap="nowrap">
            <IconLock size={14} />
            <Text size="sm" fw={500}>
              {t("Base locked")}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {t("Unlock the base from the toolbar to change its properties.")}
          </Text>
        </Stack>
      )}
      {panel === "main" && !baseLocked && (
        <MainPanel
          property={property}
          onRename={() => setPanel("rename")}
          onChangeType={() => setPanel("changeType")}
          onOptions={() => setPanel("options")}
          onDelete={() => setPanel("confirmDelete")}
          canRestrict={Boolean(base?.permissions?.canManage)}
          onVisibility={() => setPanel("visibility")}
        />
      )}
      {panel === "visibility" && (
        <Stack gap="xs" p="sm" data-testid="property-visibility">
          <Group gap="xs">
            <ActionIcon variant="subtle" color="gray" size="xs" onClick={() => setPanel("main")}>
              <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} />
            </ActionIcon>
            <Text size="xs" fw={600} c="dimmed">
              {t("Who can see this column")}
            </Text>
          </Group>
          <Radio.Group
            value={property.restrictedTo ?? "all"}
            onChange={(value) =>
              updatePropertyMutation.mutate({
                pageId,
                propertyId: property.id,
                restrictedTo: value as "all" | "editors" | "admins",
              })
            }
          >
            <Stack gap={6}>
              <Radio size="xs" value="all" label={t("Everyone who can open the base")} />
              <Radio size="xs" value="editors" label={t("Editors and space admins")} />
              <Radio size="xs" value="admins" label={t("Space admins only")} />
            </Stack>
          </Radio.Group>
          <Text size="xs" c="dimmed">
            {t("Hidden columns leave filters, sorts, exports and search for those readers.")}
          </Text>
        </Stack>
      )}
      {panel === "rename" && (
        <Stack gap="xs" p="sm">
          <Text size="xs" fw={600} c="dimmed">
            {t("Rename property")}
          </Text>
          <TextInput
            ref={renameInputRef}
            size="xs"
            value={renameValue}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
            onKeyDown={handleRenameKeyDown}
          />
          <Divider />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" size="xs" onClick={requestClose}>
              {t("Cancel")}
            </Button>
            <Button
              size="xs"
              onClick={handleRenameAndClose}
              disabled={!renameValue.trim() || renameValue.trim() === property.name}
            >
              {t("Save")}
            </Button>
          </Group>
        </Stack>
      )}
      {panel === "changeType" && (
        <Stack gap={0} p={4}>
          <Group gap="xs" px="sm" py={6}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => setPanel("main")}
            >
              <IconChevronRight
                size={14}
                style={{ transform: "rotate(180deg)" }}
              />
            </ActionIcon>
            <Text size="xs" fw={600} c="dimmed">
              {t("Change type")}
            </Text>
          </Group>
          <ScrollArea.Autosize mah={300} scrollbarSize={6} offsetScrollbars>
            <PropertyTypePicker
              onSelect={handleTypeSelect}
              currentType={property.type}
              excludeTypes={NON_USER_TARGET_TYPES}
              showSearch
            />
          </ScrollArea.Autosize>
        </Stack>
      )}
      {panel === "confirmTypeChange" && pendingTargetType && (
        <Stack gap="xs" p="sm">
          <Text size="sm" fw={600}>
            {t("Change type to {{label}}?", {
              label: t(
                propertyTypes.find((pt) => pt.type === pendingTargetType)
                  ?.labelKey ?? pendingTargetType,
              ),
            })}
          </Text>
          <Text size="xs" c="dimmed">
            {t(conversionWarning(property.type, pendingTargetType))}
          </Text>
          <Group gap="xs" justify="flex-end">
            <Button
              variant="default"
              size="xs"
              onClick={() => setPanel("main")}
            >
              {t("Cancel")}
            </Button>
            <Button size="xs" onClick={handleApplyTypeChange}>
              {t("Apply")}
            </Button>
          </Group>
        </Stack>
      )}
      {(panel === "options" || panel === "confirmDiscard") && (
        <Stack gap="xs" p="sm" style={panel === "confirmDiscard" ? { display: "none" } : undefined}>
          <Group gap="xs">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              onClick={handleOptionsBack}
            >
              <IconChevronRight
                size={14}
                style={{ transform: "rotate(180deg)" }}
              />
            </ActionIcon>
            <Text size="xs" fw={600} c="dimmed">
              {t("Property options")}
            </Text>
          </Group>
          <ScrollArea.Autosize mah={400} scrollbarSize={6} offsetScrollbars>
            <PropertyOptions
              property={property}
              onUpdate={handleOptionsUpdate}
              onClose={onClose}
              onDirtyChange={handleOptionsDirtyChange}
            />
          </ScrollArea.Autosize>
        </Stack>
      )}
      {panel === "confirmDelete" && (
        <Stack gap="xs" p="sm">
          <Text size="sm" fw={600}>
            {t("Delete property")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Are you sure you want to delete")} <b>{property.name}</b>?{" "}
            {t("All data in this column will be lost.")}
          </Text>
          <Group gap="xs" justify="flex-end">
            <Button
              variant="default"
              size="xs"
              onClick={() => setPanel("main")}
            >
              {t("Cancel")}
            </Button>
            <Button
              color="red"
              size="xs"
              onClick={handleDelete}
            >
              {t("Delete")}
            </Button>
          </Group>
        </Stack>
      )}
      {panel === "confirmDiscard" && (
        <Stack gap="xs" p="sm">
          <Text size="sm" fw={600}>
            {t("Unsaved changes")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("You have unsaved changes. Do you want to discard them?")}
          </Text>
          <Group gap="xs" justify="flex-end">
            <Button
              variant="default"
              size="xs"
              onClick={handleCancelDiscard}
            >
              {t("Keep editing")}
            </Button>
            <Button
              color="red"
              size="xs"
              onClick={handleConfirmDiscard}
            >
              {t("Discard")}
            </Button>
          </Group>
        </Stack>
      )}
    </>
  );
}

// Expose requestClose for use by parent (grid-header-cell)
PropertyMenuContent.displayName = "PropertyMenuContent";

function MenuItem({
  icon,
  label,
  rightIcon,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  rightIcon?: React.ReactNode;
  color?: string;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      className={cellClasses.menuItem}
      onClick={onClick}
      style={{ color: color ? `var(--mantine-color-${color}-6)` : undefined }}
    >
      <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
        {icon}
        <Text size="sm">{label}</Text>
      </Group>
      {rightIcon}
    </UnstyledButton>
  );
}

function MainPanel({
  property,
  onRename,
  onChangeType,
  onOptions,
  onDelete,
  canRestrict,
  onVisibility,
}: {
  property: IBaseProperty;
  onRename: () => void;
  onChangeType: () => void;
  onOptions: () => void;
  onDelete: () => void;
  canRestrict?: boolean;
  onVisibility?: () => void;
}) {
  const { t } = useTranslation();

  const isSystem = isSystemPropertyType(property.type);
  const isPending = property.pendingType != null;

  const hasOptions =
    !isPending &&
    (property.type === "select" ||
      property.type === "multiSelect" ||
      property.type === "status" ||
      property.type === "number" ||
      property.type === "date" ||
      property.type === "id" ||
      property.type === "relation" ||
      property.type === "rollup" ||
      property.type === "button" ||
      // AI autofill lives in the options of these
      property.type === "text" ||
      property.type === "longText" ||
      property.type === "checkbox");
  const aiPrompt = ((property.typeOptions ?? {}) as { ai?: { prompt?: string } }).ai?.prompt;
  const fillWithAi = async () => {
    try {
      await aiFillProperty({ pageId: property.pageId, propertyId: property.id });
      notifications.show({ message: t("Filling empty cells in the background") });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err), color: "red" });
    }
  };
  // Relations are not converted to other types; rollups are system-like.
  const canChangeType = !isSystem && !isPending && !property.isPrimary && property.type !== "relation";

  const typeDef = propertyTypes.find((pt) => pt.type === property.type);
  const TypeIcon = typeDef?.icon;

  return (
    <Stack gap={0} p={4}>
      <MenuItem
        icon={<IconPencil size={14} />}
        label={t("Rename")}
        onClick={onRename}
      />
      {isPending && (
        <Group gap={8} px="sm" py={8}>
          <Loader size={12} />
          <Text size="sm" c="dimmed">
            {t("Converting…")}
          </Text>
        </Group>
      )}
      {canChangeType && (
        <UnstyledButton
          className={cellClasses.menuItem}
          onClick={onChangeType}
        >
          <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
            {TypeIcon ? <TypeIcon size={14} /> : null}
            <Text size="sm">
              {typeDef ? t(typeDef.labelKey) : property.type}
            </Text>
          </Group>
          <IconChevronRight size={14} />
        </UnstyledButton>
      )}
      {hasOptions && (
        <MenuItem
          icon={<IconSettings size={14} />}
          label={t("Options")}
          rightIcon={<IconChevronRight size={14} />}
          onClick={onOptions}
        />
      )}
      {aiPrompt && (
        <MenuItem icon={<IconSparkles size={14} />} label={t("Fill empty cells with AI")} onClick={fillWithAi} />
      )}
      {canRestrict && !property.isPrimary && onVisibility && (
        <MenuItem
          icon={<IconLock size={14} />}
          label={property.restrictedTo && property.restrictedTo !== "all" ? t("Who can see: restricted") : t("Who can see")}
          rightIcon={<IconChevronRight size={14} />}
          onClick={onVisibility}
        />
      )}
      {!property.isPrimary && !isPending && (
        <>
          <Divider my={4} />
          <MenuItem
            icon={<IconTrash size={14} />}
            label={t("Delete property")}
            color="red"
            onClick={onDelete}
          />
        </>
      )}
    </Stack>
  );
}

