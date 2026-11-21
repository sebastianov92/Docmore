import api from "@/lib/api-client";

export type MeetingMode = "in_person" | "virtual";
export type MeetingSide = "room" | "remote";

export interface IMeetingSpeaker {
  id: string;
  number: number;
  side: MeetingSide | null;
  name: string | null;
  // what the notes call this speaker now
  label: string;
  seconds: number;
  segments: number;
  // something they said, to recognise them by
  sample: string;
}

export interface IMeetingItemVersion {
  text: string;
  owner: string | null;
  due: string | null;
  status: "active" | "cancelled";
  at: number | null;
  by: "ai" | "user";
}

export interface IMeetingItem {
  id: string;
  kind: "agreement" | "task";
  text: string;
  owner: string | null;
  due: string | null;
  status: "active" | "cancelled";
  // edited by the person: the model leaves it alone
  locked: boolean;
  at: number | null;
  updatedBy: "ai" | "user";
  history: IMeetingItemVersion[];
}

export interface IMeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  side?: MeetingSide;
}

export interface IMeetingList {
  items: IMeetingItem[];
  revision: number;
}

export interface IMeetingNotes {
  id: string;
  mode?: MeetingMode | null;
  status: "live" | "queued" | "transcribing" | "summarizing" | "done" | "failed";
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

export async function transcribeMeeting(
  file: File,
  target: { pageId?: string; spaceId?: string; meetingId?: string; mode?: MeetingMode },
): Promise<IMeetingNotes> {
  // fields go before the file: multipart fields that follow the file are not
  // available when the server starts reading it
  const form = new FormData();
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(target)) {
    if (!value) continue;
    form.append(name, value);
    query.set(name, value);
  }
  form.append("file", file);
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

export interface IMeetingDetail extends IMeetingNotes {
  speakers: IMeetingSpeaker[];
  items: IMeetingItem[];
  revision: number;
  aiAvailable: boolean;
  canManage: boolean;
}

export interface IMeetingLiveList extends IMeetingList {
  aiAvailable: boolean;
  stored: number;
}

export type MeetingItemOp =
  | { op: "add"; kind: "agreement" | "task"; text: string; owner?: string | null; due?: string | null }
  | { op: "update"; id: string; kind?: "agreement" | "task"; text?: string; owner?: string | null; due?: string | null }
  | { op: "cancel" | "restore" | "remove"; id: string };

// A meeting starts: its text arrives in pieces and the list of agreements
// and tasks is kept as it goes.
export async function startLiveMeeting(target: { pageId?: string; spaceId?: string; title?: string; mode?: MeetingMode }): Promise<IMeetingDetail> {
  return (await api.post("/ai/meetings/live/start", target)).data;
}

export async function updateLiveMeeting(meetingId: string, fromIndex: number, segments: IMeetingSegment[], durationSeconds?: number): Promise<IMeetingLiveList> {
  // a model reads the new text before this answers
  return (await api.post("/ai/meetings/live/update", { meetingId, fromIndex, segments, durationSeconds }, { timeout: 180_000 })).data;
}

export async function discardLiveMeeting(meetingId: string): Promise<void> {
  await api.post("/ai/meetings/live/discard", { meetingId });
}

export async function editMeetingItem(meetingId: string, op: MeetingItemOp): Promise<IMeetingList> {
  return (await api.post("/ai/meetings/items", { meetingId, ...op })).data;
}

export async function meetingsOfPage(pageId: string): Promise<IMeetingDetail[]> {
  return (await api.post("/ai/meetings/by-page", { pageId })).data.items;
}

export async function renameMeetingSpeaker(meetingId: string, speakerId: string, name: string): Promise<IMeetingDetail> {
  return (await api.post("/ai/meetings/speakers/rename", { meetingId, speakerId, name })).data;
}

export async function mergeMeetingSpeakers(meetingId: string, from: string, into: string): Promise<IMeetingDetail> {
  return (await api.post("/ai/meetings/speakers/merge", { meetingId, from, into })).data;
}

export const MEETING_SPEAKERS_EVENT = "docmore:meeting-speakers";
