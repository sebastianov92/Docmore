import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFileTypePdf } from "@tabler/icons-react";
import { exportSpaceToPdf } from "./services";
import { getApiErrorMessage } from "@/lib/api-error";

// Every space, every page, as PDFs in one zip.
export function WorkspacePdfExportButton() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    try {
      await exportSpaceToPdf(null, setStatus);
      notifications.show({ message: t("Export successful") });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err, t("Export failed")), color: "red" });
    } finally {
      setStatus(null);
    }
  };
  return (
    <Tooltip label={t("Every page of every space, printed to PDF (needs the PDF renderer)")}>
      <Button variant="default" leftSection={<IconFileTypePdf size={16} />} onClick={run} loading={status !== null} data-testid="workspace-pdf-export">
        {status === "rendering" ? t("Printing…") : status === "downloading" ? t("Downloading…") : t("Export all as PDF")}
      </Button>
    </Tooltip>
  );
}
