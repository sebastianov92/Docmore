import { ActionIcon, Button, Card, Menu } from "@mantine/core";
import { IconDots, IconFileText, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ITemplate } from "@/features/template/types/template.types.ts";
import { templateTitle } from "@/features/template/template.utils.ts";
import classes from "./template-card.module.css";

interface TemplateCardProps {
  template: ITemplate;
  scopeLabel: string;
  canManage: boolean;
  onOpen: (template: ITemplate) => void;
  onUse: (template: ITemplate) => void;
  onEdit: (template: ITemplate) => void;
  onDelete: (template: ITemplate) => void;
}

// The whole card opens the preview; the buttons on it stop the click from bubbling.
export function TemplateCard({
  template,
  scopeLabel,
  canManage,
  onOpen,
  onUse,
  onEdit,
  onDelete,
}: TemplateCardProps) {
  const { t } = useTranslation();
  const title = templateTitle(template, t("Untitled"));

  return (
    <Card
      radius="md"
      padding="lg"
      className={classes.card}
      role="button"
      tabIndex={0}
      aria-label={t("Preview template {{title}}", { title })}
      onClick={() => onOpen(template)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(template);
        }
      }}
    >
      <div className={classes.top}>
        <div className={classes.icon} aria-hidden="true">
          {template.icon ? template.icon : <IconFileText size={20} stroke={1.5} />}
        </div>

        <div className={classes.actions}>
          <Button
            size="compact-xs"
            onClick={(event) => {
              event.stopPropagation();
              onUse(template);
            }}
          >
            {t("Use")}
          </Button>
          {canManage && (
            <Menu width={160} shadow="md" position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label={t("Template actions")}
                  onClick={(event) => event.stopPropagation()}
                >
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(template)}>
                  {t("Edit")}
                </Menu.Item>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => onDelete(template)}
                >
                  {t("Delete")}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
      </div>

      <div className={classes.title}>{title}</div>
      {template.description && (
        <div className={classes.description}>{template.description}</div>
      )}

      <div className={classes.footer}>{scopeLabel}</div>
    </Card>
  );
}
