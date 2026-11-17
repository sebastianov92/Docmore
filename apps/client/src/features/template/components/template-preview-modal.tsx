import { Button, Center, Group, Loader, Modal, ScrollArea, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useTemplateQuery } from "@/features/template/queries/template-query.ts";
import { templateTitle } from "@/features/template/template.utils.ts";
import { TemplateReadonlyView } from "./template-readonly-view.tsx";

interface TemplatePreviewModalProps {
  templateId: string;
  opened: boolean;
  onClose: () => void;
  onUse: () => void;
  onEdit?: () => void;
  useLoading?: boolean;
}

export function TemplatePreviewModal({
  templateId,
  opened,
  onClose,
  onUse,
  onEdit,
  useLoading,
}: TemplatePreviewModalProps) {
  const { t } = useTranslation();
  const { data: template, isLoading } = useTemplateQuery(templateId);
  const title = template ? templateTitle(template, t("Untitled")) : t("Template");

  return (
    <Modal.Root size={1200} opened={opened} onClose={onClose} aria-label={title}>
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Header>
          <Modal.Title>
            <Group gap="xs" wrap="nowrap">
              {template?.icon && <Text size="lg">{template.icon}</Text>}
              <Text size="md" fw={500} lineClamp={1}>
                {title}
              </Text>
            </Group>
          </Modal.Title>
          <Group gap="sm" wrap="nowrap">
            <Button size="xs" onClick={onUse} loading={useLoading} disabled={useLoading}>
              {t("Use template")}
            </Button>
            {onEdit && (
              <Button size="xs" variant="default" onClick={onEdit}>
                {t("Edit")}
              </Button>
            )}
            <Modal.CloseButton aria-label={t("Close")} />
          </Group>
        </Modal.Header>
        <Modal.Body p={0}>
          {isLoading || !template ? (
            <Center py="xl">
              <Loader size="sm" />
            </Center>
          ) : (
            <ScrollArea h="80vh" w="100%" scrollbarSize={5}>
              <TemplateReadonlyView template={template} />
            </ScrollArea>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
