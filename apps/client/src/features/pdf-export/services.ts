import { saveAs } from "file-saver";
import api from "@/lib/api-client";
import { getFileTaskById } from "@/features/file-task/services/file-task-service";

const POLL_MS = 1500;
const MAX_WAIT_MS = 120_000;

export async function getPdfExportConfig(): Promise<{ enabled: boolean }> {
  const req = await api.post<{ enabled: boolean }>("/pdf-export/config", {});
  return req.data;
}

// Starts the export, waits for the file task to finish, downloads the PDF.
export async function exportPageToPdf(pageId: string, onStatus?: (status: string) => void): Promise<void> {
  const start = await api.post<{ fileTaskId: string }>("/pdf-export", { pageId });
  const fileTaskId = start.data.fileTaskId;
  const deadline = Date.now() + MAX_WAIT_MS;
  onStatus?.("rendering");
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const task = await getFileTaskById(fileTaskId);
    if (task.status === "success") break;
    if (task.status === "failed") {
      throw new Error(task.errorMessage || "The PDF could not be made");
    }
  }
  onStatus?.("downloading");
  const file = await api.post("/pdf-export/download", { fileTaskId }, { responseType: "blob" });
  const header: string = file.headers["content-disposition"] ?? "";
  let fileName = header.split("filename=")[1]?.replace(/"/g, "") || "page.pdf";
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    /* keep raw name */
  }
  saveAs(file.data, fileName);
}

// A space (or every space when spaceId is null) as a zip of PDFs.
export async function exportSpaceToPdf(spaceId: string | null, onStatus?: (status: string) => void): Promise<void> {
  const start = await api.post<{ fileTaskId: string }>("/pdf-export/space", spaceId ? { spaceId } : {});
  const fileTaskId = start.data.fileTaskId;
  const deadline = Date.now() + 20 * 60_000;
  onStatus?.("rendering");
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const task = await getFileTaskById(fileTaskId);
    if (task.status === "success") break;
    if (task.status === "failed") throw new Error(task.errorMessage || "The PDFs could not be made");
  }
  onStatus?.("downloading");
  const file = await api.post("/pdf-export/download", { fileTaskId }, { responseType: "blob" });
  const header: string = file.headers["content-disposition"] ?? "";
  let fileName = header.split("filename=")[1]?.replace(/"/g, "") || "export-pdf.zip";
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    /* keep raw name */
  }
  saveAs(file.data, fileName);
}
