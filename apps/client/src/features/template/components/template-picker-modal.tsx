import { useMemo, useState } from "react";
import {
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowRight, IconFileText, IconSearch } from "@tabler/icons-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery, useUnlistedSpaceQuery } from "@/features/space/queries/space-query";
import { includeSpace } from "@/features/space/space.utils";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  useCreatePageFromTemplateMutation,
  useTemplatesQuery,
} from "@/features/template/queries/template-query.ts";
import { ITemplate } from "@/features/template/types/template.types.ts";
import { templateTitle } from "@/features/template/template.utils.ts";
import { TemplatePreviewModal } from "./template-preview-modal.tsx";
import { UseTemplateModal } from "./use-template-modal.tsx";
import classes from "./template-picker-modal.module.css";

interface TemplatePickerModalProps {
  opened: boolean;
  onClose: () => void;
  // Space the picker was opened from: filters the list and is where new pages go.
  initialSpaceId?: string;
  // When set, hands the chosen template back instead of creating a page.
  onUse?: (template: ITemplate) => void;
}

type Scope = "space" | "all";

export default function TemplatePickerModal({
  opened,
  onClose,
  initialSpaceId,
  onUse,
}: TemplatePickerModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createMutation = useCreatePageFromTemplateMutation();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [scope, setScope] = useState<Scope>(initialSpaceId ? "space" : "all");
  const [previewing, setPreviewing] = useState<ITemplate | null>(null);
  const [choosingDestination, setChoosingDestination] = useState<ITemplate | null>(null);

  const { data, isPending } = useTemplatesQuery({
    spaceId: scope === "space" ? initialSpaceId : undefined,
    currentSpaceId: scope === "all" ? initialSpaceId : undefined,
  });
  const { data: spacesData } = useGetSpacesQuery({ limit: 100 });
  const { data: initialSpace } = useUnlistedSpaceQuery(initialSpaceId, spacesData?.items);

  const spaces = useMemo(
    () => includeSpace(spacesData?.items ?? [], initialSpace),
    [spacesData, initialSpace],
  );
  const spaceNames = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces]);

  const templates = useMemo(() => {
    const all = data?.pages.flatMap((page) => page.items) ?? [];
    const term = debouncedQuery.trim().toLowerCase();
    if (!term) return all;
    return all.filter((template) =>
      templateTitle(template, "").toLowerCase().includes(term),
    );
  }, [data, debouncedQuery]);

  const reset = () => {
    setQuery("");
    setScope(initialSpaceId ? "space" : "all");
    setPreviewing(null);
    setChoosingDestination(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // Creating straight into the current space skips the destination step.
  const createHere = async (template: ITemplate) => {
    if (!initialSpaceId) return;
    try {
      const page = await createMutation.mutateAsync({
        templateId: template.id,
        spaceId: initialSpaceId,
      });
      handleClose();
      const space = spaces.find((item) => item.id === initialSpaceId);
      if (page?.slugId && space?.slug) {
        navigate(buildPageUrl(space.slug, page.slugId, page.title));
      }
    } catch {
      // the mutation already showed the error
    }
  };

  const useTemplate = (template: ITemplate) => {
    if (onUse) {
      onUse(template);
      handleClose();
      return;
    }
    if (initialSpaceId) {
      createHere(template);
      return;
    }
    setPreviewing(null);
    setChoosingDestination(template);
  };

  const scopeLabel = (template: ITemplate) =>
    template.spaceId ? spaceNames.get(template.spaceId) ?? t("Space") : t("Workspace");

  return (
    <>
      <Modal
        opened={opened && !previewing && !choosingDestination}
        onClose={handleClose}
        size={560}
        padding="lg"
        yOffset="10vh"
        title={<Text fw={500}>{t("Start from a template")}</Text>}
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t("Search templates")}
          variant="filled"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          mb="xs"
          autoFocus
        />

        {initialSpaceId && (
          <SegmentedControl
            fullWidth
            size="xs"
            mb="sm"
            value={scope}
            onChange={(value) => setScope(value as Scope)}
            data={[
              { label: t("This space"), value: "space" },
              { label: t("All templates"), value: "all" },
            ]}
          />
        )}

        <ScrollArea h="50vh" offsetScrollbars>
          {isPending ? (
            <div className={classes.empty}>
              <Loader size="xs" />
            </div>
          ) : templates.length === 0 ? (
            <div className={classes.empty}>
              <Text size="sm" c="dimmed">
                {t("No templates yet")}
              </Text>
            </div>
          ) : (
            templates.map((template) => (
              <div key={template.id} className={classes.row}>
                <UnstyledButton
                  className={classes.rowButton}
                  onClick={() => setPreviewing(template)}
                  aria-label={t("Preview template {{title}}", {
                    title: templateTitle(template, t("Untitled")),
                  })}
                >
                  <span className={classes.icon} aria-hidden="true">
                    {template.icon ? template.icon : <IconFileText size={16} />}
                  </span>
                  <span className={classes.title}>{templateTitle(template, t("Untitled"))}</span>
                  <span className={classes.scope}>{scopeLabel(template)}</span>
                </UnstyledButton>
                <Button
                  size="compact-xs"
                  className={classes.useButton}
                  loading={createMutation.isPending}
                  disabled={createMutation.isPending}
                  onClick={() => useTemplate(template)}
                >
                  {t("Use")}
                </Button>
              </div>
            ))
          )}
        </ScrollArea>

        <Group justify="flex-end" mt="md">
          <Button
            component={Link}
            to="/templates"
            variant="subtle"
            size="sm"
            rightSection={<IconArrowRight size={16} />}
            onClick={handleClose}
          >
            {t("Browse all templates")}
          </Button>
        </Group>
      </Modal>

      {previewing && (
        <TemplatePreviewModal
          templateId={previewing.id}
          opened={true}
          onClose={() => setPreviewing(null)}
          onUse={() => useTemplate(previewing)}
          useLoading={createMutation.isPending}
        />
      )}

      {choosingDestination && (
        <UseTemplateModal
          template={choosingDestination}
          opened={true}
          onClose={() => {
            setChoosingDestination(null);
            onClose();
          }}
          initialSpaceId={initialSpaceId}
        />
      )}
    </>
  );
}
