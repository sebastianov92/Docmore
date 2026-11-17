import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { DestinationPickerModal } from "@/components/ui/destination-picker/destination-picker-modal";
import { DestinationSelection } from "@/components/ui/destination-picker/destination-picker.types";
import { buildPageUrl } from "@/features/page/page.utils";
import { ITemplate } from "@/features/template/types/template.types.ts";
import { useCreatePageFromTemplateMutation } from "@/features/template/queries/template-query.ts";

interface UseTemplateModalProps {
  template: ITemplate;
  opened: boolean;
  onClose: () => void;
  initialSpaceId?: string;
}

// Asks where the new page goes, creates it, and opens it.
export function UseTemplateModal({ template, opened, onClose, initialSpaceId }: UseTemplateModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createMutation = useCreatePageFromTemplateMutation();

  const handleSelect = async (selection: DestinationSelection) => {
    try {
      const page = await createMutation.mutateAsync({
        templateId: template.id,
        spaceId: selection.spaceId,
        parentPageId: selection.type === "page" ? selection.pageId : undefined,
      });
      onClose();
      if (page?.slugId && selection.space?.slug) {
        navigate(buildPageUrl(selection.space.slug, page.slugId, page.title));
      }
    } catch {
      // the mutation already showed the error
    }
  };

  return (
    <DestinationPickerModal
      opened={opened}
      onClose={onClose}
      title={t("Where should the new page go?")}
      actionLabel={t("Create page")}
      onSelect={handleSelect}
      loading={createMutation.isPending}
      initialSpaceId={initialSpaceId ?? template.spaceId ?? undefined}
      searchSpacesOnly
    />
  );
}
