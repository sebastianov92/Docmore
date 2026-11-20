import api from "@/lib/api-client";

export interface IMeetingNotes {
  id: string;
  status: "queued" | "transcribing" | "summarizing" | "done" | "failed";
  fileName: string | null;
  pageId: string | null;
  spaceId: string | null;
  language: string | null;
  durationSeconds: number | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MEETING_ACCEPTED_FILES = ".mp3,.m4a,.wav,.webm,.ogg,.oga,.mp4,.mpga,.mpeg,.flac,.aac,audio/*";

export async function transcribeMeeting(file: File, target: { pageId?: string; spaceId?: string }): Promise<IMeetingNotes> {
  // fields go before the file: multipart fields that follow the file are not
  // available when the server starts reading it
  const form = new FormData();
  if (target.pageId) form.append("pageId", target.pageId);
  if (target.spaceId) form.append("spaceId", target.spaceId);
  form.append("file", file);
  const query = new URLSearchParams();
  if (target.pageId) query.set("pageId", target.pageId);
  if (target.spaceId) query.set("spaceId", target.spaceId);
  return (await api.post(`/ai/meetings/transcribe?${query.toString()}`, form, { headers: { "Content-Type": "multipart/form-data" } })).data;
}
// One piece of a running recording -> its text.
export async function transcribeLiveChunk(blob: Blob, fileName: string): Promise<{ text: string; language: string | null }> {
  const form = new FormData();
  form.append("file", blob, fileName);
  return (await api.post("/ai/meetings/live", form, { headers: { "Content-Type": "multipart/form-data" } })).data;
}

export const MEETING_RECORDER_EVENT = "docmore:record-meeting";

export async function meetingStatus(meetingId: string): Promise<IMeetingNotes> {
  return (await api.post("/ai/meetings/status", { meetingId })).data;
}
