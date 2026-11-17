import {
  Modal,
  Button,
  Group,
  Text,
  Select,
  Switch,
  Divider,
  Tooltip,
  Badge,
} from "@mantine/core";
import {
  exportPage,
  exportPageToDocx,
} from "@/features/page/services/page-service.ts";
import { useState } from "react";
import { ExportFormat } from "@/features/page/types/page.types.ts";
import { notifications } from "@mantine/notifications";
import { exportSpace } from "@/features/space/services/space-service";
import { getApiErrorMessage } from "@/lib/api-error";
import { useTranslation } from "react-i18next";
import { Feature } from "@/ee/features";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { useUpgradeLabel } from "@/ee/hooks/use-upgrade-label";
import { exportPageToPdf } from "@/features/pdf-export/services";

interface ExportModalProps {
  id: string;
  type: "space" | "page";
  open: boolean;
  onClose: () => void;
}

export default function ExportModal({
  id,
  type,
  open,
  onClose,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>(ExportFormat.Markdown);
  const [includeChildren, setIncludeChildren] = useState<boolean>(false);
  const [includeAttachments, setIncludeAttachments] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const { t } = useTranslation();
  const upgradeLabel = useUpgradeLabel();
  const isDocx = format === ExportFormat.Docx;
  const isPdf = format === ExportFormat.Pdf;
  const docxEntitled = useHasFeature(Feature.DOCX_EXPORT);
  const pdfEntitled = useHasFeature("export:pdf");
  const blockedByLicense = (isDocx && !docxEntitled) || (isPdf && !pdfEntitled);
  const [pdfStatus, setPdfStatus] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      if (type === "page") {
        if (format === ExportFormat.Docx) {
          await exportPageToDocx({ pageId: id });
        } else if (format === ExportFormat.Pdf) {
          await exportPageToPdf(id, setPdfStatus);
        } else {
          await exportPage({
            pageId: id,
            format,
            includeChildren,
            includeAttachments,
          });
        }
      }
      if (type === "space") {
        await exportSpace({ spaceId: id, format, includeAttachments });
      }
      notifications.show({
        message: t("Export successful"),
      });
      onClose();
    } catch (err) {
      notifications.show({
        message: getApiErrorMessage(err, t("Export failed")),
        color: "red",
      });
      console.error("export error", err);
    } finally {
      setIsExporting(false);
      setPdfStatus(null);
    }
  };

  const handleChange = (format: ExportFormat) => {
    setFormat(format);
  };

  return (
    <Modal.Root
      opened={open}
      onClose={onClose}
      size={500}
      padding="xl"
      yOffset="10vh"
      xOffset={0}
      mah={400}
      onClick={(e) => e.stopPropagation()}
    >
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Header py={0}>
          <Modal.Title fw={500}>{t(`Export ${type}`)}</Modal.Title>
          <Modal.CloseButton aria-label={t("Close")} />
        </Modal.Header>
        <Modal.Body>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text size="md">{t("Format")}</Text>
            </div>
            <ExportFormatSelection
              format={format}
              onChange={handleChange}
              includeDocx={type === "page"}
              docxEntitled={docxEntitled}
              includePdf={type === "page"}
              pdfEntitled={pdfEntitled}
            />
          </Group>

          {isPdf && (
            <Text size="sm" c="dimmed" mt="sm">
              {pdfStatus === "rendering"
                ? t("Rendering the page…")
                : pdfStatus === "downloading"
                  ? t("Downloading…")
                  : t("The page is printed on the server as it looks on screen. It can take a few seconds.")}
            </Text>
          )}

          {type === "page" && !isDocx && !isPdf && (
            <>
              <Divider my="sm" />

              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="md">{t("Include subpages")}</Text>
                </div>
                <Switch
                  onChange={(event) =>
                    setIncludeChildren(event.currentTarget.checked)
                  }
                  checked={includeChildren}
                />
              </Group>

              <Group justify="space-between" wrap="nowrap" mt="md">
                <div>
                  <Text size="md">{t("Include attachments")}</Text>
                </div>
                <Switch
                  onChange={(event) =>
                    setIncludeAttachments(event.currentTarget.checked)
                  }
                  checked={includeAttachments}
                />
              </Group>
            </>
          )}

          {type === "space" && (
            <>
              <Divider my="sm" />

              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="md">{t("Include attachments")}</Text>
                </div>
                <Switch
                  onChange={(event) =>
                    setIncludeAttachments(event.currentTarget.checked)
                  }
                  checked={includeAttachments}
                />
              </Group>
            </>
          )}

          <Group justify="center" mt="md">
            <Button onClick={onClose} variant="default">
              {t("Cancel")}
            </Button>
            <Tooltip label={upgradeLabel} disabled={!blockedByLicense} withArrow>
              <Button
                onClick={handleExport}
                loading={isExporting}
                disabled={blockedByLicense}
                data-disabled={blockedByLicense || undefined}
              >
                {t("Export")}
              </Button>
            </Tooltip>
          </Group>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

interface ExportFormatSelection {
  format: ExportFormat;
  onChange: (value: string) => void;
  includeDocx?: boolean;
  docxEntitled?: boolean;
  includePdf?: boolean;
  pdfEntitled?: boolean;
}
function ExportFormatSelection({
  format,
  onChange,
  includeDocx,
  docxEntitled,
  includePdf,
  pdfEntitled,
}: ExportFormatSelection) {
  const { t } = useTranslation();

  const data = [
    { value: "markdown", label: "Markdown" },
    { value: "html", label: "HTML" },
    ...(includeDocx
      ? [{ value: "docx", label: "Word (.docx)", disabled: !docxEntitled }]
      : []),
    ...(includePdf ? [{ value: "pdf", label: "PDF", disabled: !pdfEntitled }] : []),
  ];

  return (
    <Select
      data={data}
      defaultValue={format}
      onChange={onChange}
      styles={{ wrapper: { maxWidth: 140 }, option: { opacity: 1 } }}
      comboboxProps={{ width: 200 }}
      allowDeselect={false}
      withCheckIcon={false}
      aria-label={t("Select export format")}
      renderOption={({ option }) =>
        (option.value === "docx" && !docxEntitled) || (option.value === "pdf" && !pdfEntitled) ? (
          <div>
            <Text size="sm" c="dimmed">
              {option.label}
            </Text>
            <Badge size="xs" mt={4}>
              {t("Enterprise")}
            </Badge>
          </div>
        ) : (
          <Text size="sm">{option.label}</Text>
        )
      }
    />
  );
}
