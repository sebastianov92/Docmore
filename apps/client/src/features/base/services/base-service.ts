import api from "@/lib/api-client";
import { saveAs } from "file-saver";
import {
  IBase,
  IBaseProperty,
  IBaseRow,
  IBaseView,
  CreateBaseInput,
  UpdateBaseInput,
  CreatePropertyInput,
  UpdatePropertyInput,
  DeletePropertyInput,
  ReorderPropertyInput,
  CreateRowInput,
  UpdateRowInput,
  DeleteRowInput,
  DeleteRowsInput,
  ReorderRowInput,
  CreateViewInput,
  UpdateViewInput,
  DeleteViewInput,
  UpdatePropertyResult,
  FilterNode,
  SearchSpec,
  ViewSortConfig,
  CountRowsInput,
  CountRowsResult,
  BaseTemplate,
  RowReferences,
  IRowVersionPage,
  IAutomation,
  AutomationTrigger,
  AutomationAction,
  FilterGroup,
  IAutomationRun,
  IBaseForm,
  FormField,
  IPublicForm,
} from "@/features/base/types/base.types";
import { IPagination } from "@/lib/types";
import { ImportSpec } from "@/features/base/csv-import/csv-import.types";
import { IFileTask } from "@/features/file-task/types/file-task.types";
import { BasePublicContext } from "@/features/base/atoms/public-context-atom";

// --- Bases ---

export async function createBase(data: CreateBaseInput): Promise<IBase> {
  const req = await api.post<IBase>("/bases/create", data);
  return req.data;
}

// Turns an empty page into a base in place (keeps id, slug and position).
export async function convertPageToBase(
  pageId: string,
  template?: BaseTemplate,
): Promise<IBase> {
  const req = await api.post<IBase>("/bases/convert", { pageId, template });
  return req.data;
}

export async function getBaseInfo(pageId: string): Promise<IBase> {
  const req = await api.post<IBase>("/bases/info", { pageId });
  return req.data;
}

export async function updateBase(data: UpdateBaseInput): Promise<IBase> {
  const req = await api.post<IBase>("/bases/update", data);
  return req.data;
}

export async function deleteBase(pageId: string): Promise<void> {
  await api.post("/bases/delete", { pageId });
}

// Multipart upload of the mapped rows (JSONL) and the column spec; the
// server queues the import and answers with the file task to follow.
export async function importBaseCsv(
  pageId: string,
  spec: ImportSpec,
  jsonl: Blob,
): Promise<IFileTask> {
  const form = new FormData();
  form.append("pageId", pageId);
  form.append("spec", JSON.stringify(spec));
  form.append("file", jsonl, "rows.jsonl");
  const req = await api.post<IFileTask>("/bases/import-csv", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return req.data;
}

export async function exportBaseToCsv(pageId: string): Promise<void> {
  const req = await api.post(
    "/bases/export-csv",
    { pageId },
    { responseType: "blob" },
  );

  const header = (req?.headers?.["content-disposition"] as string) ?? "";
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  let fileName = utf8Match?.[1] ?? plainMatch?.[1] ?? "base.csv";
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // fallback to raw filename
  }

  saveAs(req.data, fileName);
}

export async function listBases(
  spaceId: string,
  params?: { cursor?: string; limit?: number },
): Promise<IPagination<IBase>> {
  const req = await api.post("/bases", { spaceId, ...params });
  return req.data;
}

// --- Properties ---

export async function createProperty(
  data: CreatePropertyInput,
): Promise<IBaseProperty> {
  const req = await api.post<IBaseProperty>("/bases/properties/create", data);
  return req.data;
}

export async function updateProperty(
  data: UpdatePropertyInput,
): Promise<UpdatePropertyResult> {
  const req = await api.post<UpdatePropertyResult>(
    "/bases/properties/update",
    data,
  );
  return req.data;
}

export async function deleteProperty(data: DeletePropertyInput): Promise<void> {
  await api.post("/bases/properties/delete", data);
}

export async function reorderProperty(
  data: ReorderPropertyInput,
): Promise<void> {
  await api.post("/bases/properties/reorder", data);
}

// --- Rows ---

export async function createRow(data: CreateRowInput): Promise<IBaseRow> {
  const req = await api.post<IBaseRow>("/bases/rows/create", data);
  return req.data;
}

export async function getRowInfo(
  rowId: string,
  pageId: string,
): Promise<IBaseRow> {
  const req = await api.post<IBaseRow>("/bases/rows/info", { rowId, pageId });
  return req.data;
}

export async function updateRow(data: UpdateRowInput): Promise<IBaseRow> {
  const req = await api.post<IBaseRow>("/bases/rows/update", data);
  return req.data;
}

export async function deleteRow(data: DeleteRowInput): Promise<void> {
  await api.post("/bases/rows/delete", data);
}

export async function deleteRows(data: DeleteRowsInput): Promise<void> {
  await api.post("/bases/rows/delete-many", data);
}

// Public readers (share link or published space) read through these.
export async function getPublicBaseInfo(
  pageId: string,
  ctx: BasePublicContext,
): Promise<IBase> {
  const req = await api.post<IBase>("/bases/public/info", { pageId, shareId: ctx.shareId });
  return req.data;
}

export async function listPublicRows(
  pageId: string,
  ctx: BasePublicContext,
  params?: {
    cursor?: string;
    limit?: number;
    filter?: FilterNode;
    sorts?: ViewSortConfig[];
    search?: SearchSpec;
  },
): Promise<IPagination<IBaseRow> & { references?: RowReferences }> {
  const req = await api.post("/bases/public/rows", { pageId, shareId: ctx.shareId, ...params });
  return req.data;
}

export async function listRows(
  pageId: string,
  params?: {
    viewId?: string;
    cursor?: string;
    limit?: number;
    filter?: FilterNode;
    sorts?: ViewSortConfig[];
    search?: SearchSpec;
    templates?: boolean;
  },
): Promise<IPagination<IBaseRow> & { references?: RowReferences }> {
  const req = await api.post("/bases/rows", { pageId, ...params });
  return req.data;
}

export async function reorderRow(data: ReorderRowInput): Promise<void> {
  await api.post("/bases/rows/reorder", data);
}

export async function countRows(
  data: CountRowsInput,
): Promise<CountRowsResult> {
  const req = await api.post<CountRowsResult>("/bases/rows/count", data);
  return req.data;
}

// --- Views ---

export async function createView(data: CreateViewInput): Promise<IBaseView> {
  const req = await api.post<IBaseView>("/bases/views/create", data);
  return req.data;
}

export async function updateView(data: UpdateViewInput): Promise<IBaseView> {
  const req = await api.post<IBaseView>("/bases/views/update", data);
  return req.data;
}

export async function deleteView(data: DeleteViewInput): Promise<void> {
  await api.post("/bases/views/delete", data);
}

export async function listViews(pageId: string): Promise<IBaseView[]> {
  const req = await api.post<IBaseView[]>("/bases/views", { pageId });
  return req.data;
}

// --- History ---
export async function listBaseHistory(params: {
  pageId: string;
  rowId?: string;
  before?: string;
  limit?: number;
}): Promise<IRowVersionPage> {
  const req = await api.post("/bases/history", params);
  return req.data;
}

export async function restoreBaseVersion(params: { pageId: string; versionId: string }): Promise<{ row: IBaseRow; restoredDeleted: boolean }> {
  const req = await api.post("/bases/history/restore", params);
  return req.data;
}

export async function restoreDeletedRows(params: { pageId: string; since: string }): Promise<{ count: number }> {
  const req = await api.post("/bases/history/restore-deleted", params);
  return req.data;
}

// --- Automations ---
export async function listAutomations(pageId: string): Promise<{ items: IAutomation[] }> {
  const req = await api.post("/bases/automations", { pageId });
  return req.data;
}
export async function createAutomation(data: {
  pageId: string;
  name: string;
  enabled?: boolean;
  trigger: AutomationTrigger;
  conditions?: FilterGroup | null;
  actions: AutomationAction[];
}): Promise<IAutomation> {
  const req = await api.post("/bases/automations/create", data);
  return req.data;
}
export async function updateAutomation(data: {
  pageId: string;
  automationId: string;
  name?: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  conditions?: FilterGroup | null;
  actions?: AutomationAction[];
}): Promise<IAutomation> {
  const req = await api.post("/bases/automations/update", data);
  return req.data;
}
export async function deleteAutomation(data: { pageId: string; automationId: string }): Promise<void> {
  await api.post("/bases/automations/delete", data);
}
export async function runAutomation(data: { pageId: string; automationId: string; rowId?: string }): Promise<{ ran: boolean; ok?: boolean; errors?: string[]; reason?: string }> {
  const req = await api.post("/bases/automations/run", data);
  return req.data;
}
export async function listAutomationRuns(data: { pageId: string; automationId: string; limit?: number }): Promise<{ items: IAutomationRun[] }> {
  const req = await api.post("/bases/automations/runs", data);
  return req.data;
}

// --- Forms ---
export async function listForms(pageId: string): Promise<{ items: IBaseForm[] }> {
  const req = await api.post("/bases/forms", { pageId });
  return req.data;
}
export async function createForm(data: Partial<IBaseForm> & { pageId: string; name: string; fields: FormField[] }): Promise<IBaseForm> {
  const req = await api.post("/bases/forms/create", data);
  return req.data;
}
export async function updateForm(data: Partial<IBaseForm> & { pageId: string; formId: string }): Promise<IBaseForm> {
  const req = await api.post("/bases/forms/update", data);
  return req.data;
}
export async function deleteForm(data: { pageId: string; formId: string }): Promise<void> {
  await api.post("/bases/forms/delete", data);
}
export async function getPublicForm(token: string): Promise<IPublicForm> {
  const req = await api.post("/forms/public/info", { token });
  return req.data;
}
export async function submitPublicForm(data: { token: string; cells: Record<string, unknown>; website?: string }): Promise<{ id: string; thanksText: string | null }> {
  const req = await api.post("/forms/public/submit", data);
  return req.data;
}

// --- AI autofill ---
export async function aiFillProperty(data: { pageId: string; propertyId: string; rowIds?: string[] }): Promise<{ queued: boolean }> {
  const req = await api.post("/ai/bases/fill", data);
  return req.data;
}

// --- Calendar subscription (.ics) ---
export type CalendarFeedInfo = {
  enabled: boolean;
  path: string | null;
  createdAt: string | null;
  lastReadAt: string | null;
};
export async function getCalendarFeed(data: { pageId: string; viewId: string }): Promise<CalendarFeedInfo> {
  const req = await api.post("/bases/calendar-feed/info", data);
  return req.data;
}
export async function createCalendarFeed(data: { pageId: string; viewId: string }): Promise<CalendarFeedInfo> {
  const req = await api.post("/bases/calendar-feed/create", data);
  return req.data;
}
export async function removeCalendarFeed(data: { pageId: string; viewId: string }): Promise<CalendarFeedInfo> {
  const req = await api.post("/bases/calendar-feed/remove", data);
  return req.data;
}
