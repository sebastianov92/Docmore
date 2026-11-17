import { useState } from "react";
import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import useUserRole from "@/hooks/use-user-role";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { useCreateTemplateMutation } from "@/features/template/queries/template-query.ts";
import { TemplateScopeSelect } from "./template-scope-select.tsx";

interface CreateTemplateModalProps {
  opened: boolean;
  onClose: () => void;
  initialSpaceId?: string;
}

export function CreateTemplateModal({ opened, onClose, initialSpaceId }: CreateTemplateModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin } = useUserRole();
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const createMutation = useCreateTemplateMutation();
  const [title, setTitle] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(initialSpaceId ?? null);

  const spaceItems = spaces?.items ?? [];
  // Members must pick a space; default to the first one they have.
  const effectiveSpaceId = spaceId ?? (isAdmin ? null : spaceItems[0]?.id ?? null);
  const canSubmit = title.trim().length > 0 && (isAdmin || !!effectiveSpaceId);

  const reset = () => {
    setTitle("");
    setSpaceId(initialSpaceId ?? null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleCreate = async () => {
    if (!canSubmit || createMutation.isPending) return;
    try {
      const created = await createMutation.mutateAsync({
        title: title.trim(),
        spaceId: effectiveSpaceId,
      });
      reset();
      onClose();
      navigate(`/templates/${created.id}`);
    } catch {
      // the mutation already showed the error
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("New template")}
      centered
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      <Stack gap="md">
        <TextInput
          label={t("Title")}
          placeholder={t("e.g. Meeting notes")}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          data-autofocus
          onKeyDown={(event) => {
            if (event.key === "Enter") handleCreate();
          }}
        />

        <TemplateScopeSelect
          spaces={spaceItems}
          value={effectiveSpaceId}
          onChange={setSpaceId}
          description={t("Who can pick this template when creating a page.")}
        />

        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={handleClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={handleCreate} loading={createMutation.isPending} disabled={!canSubmit}>
            {t("Create")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
