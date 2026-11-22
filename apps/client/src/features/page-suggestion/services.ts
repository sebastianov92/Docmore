import { atom } from "jotai";
import api from "@/lib/api-client";

export interface ISuggestion {
  id: string;
  pageId: string;
  spaceId: string;
  authorId: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  title: string | null;
  note: string | null;
  status: "open" | "accepted" | "rejected" | "withdrawn";
  reviewerId: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  // who wrote it when it was not a person typing: chat | agent | mcp
  origin?: "chat" | "agent" | "mcp" | null;
  originLabel?: string | null;
  operation?: "replace" | "append" | "prepend";
  content?: unknown;
  baseContent?: unknown;
}

export const SUGGESTIONS_KEY = (pageId: string) => ["page-suggestions", pageId];
export const SUGGESTION_COUNT_KEY = (pageId: string) => ["page-suggestions-count", pageId];

// true while the suggest editor is open for the current page
export const suggestEditorOpenAtom = atom(false);
// true while the review list is open
export const suggestionsModalOpenAtom = atom(false);

export async function listSuggestions(pageId: string, status?: string): Promise<{ items: ISuggestion[] }> {
  return (await api.post("/pages/suggestions", { pageId, status })).data;
}
export async function countSuggestions(pageId: string): Promise<{ open: number }> {
  return (await api.post("/pages/suggestions/count", { pageId })).data;
}
export async function suggestionInfo(suggestionId: string): Promise<ISuggestion & { pageContent: unknown; canReview: boolean }> {
  return (await api.post("/pages/suggestions/info", { suggestionId })).data;
}
export async function createSuggestion(data: { pageId: string; content: unknown; title?: string; note?: string }): Promise<ISuggestion> {
  return (await api.post("/pages/suggestions/create", data)).data;
}
export async function acceptSuggestion(suggestionId: string, reviewNote?: string): Promise<ISuggestion> {
  return (await api.post("/pages/suggestions/accept", { suggestionId, reviewNote })).data;
}
export async function rejectSuggestion(suggestionId: string, reviewNote?: string): Promise<ISuggestion> {
  return (await api.post("/pages/suggestions/reject", { suggestionId, reviewNote })).data;
}
export async function withdrawSuggestion(suggestionId: string): Promise<ISuggestion> {
  return (await api.post("/pages/suggestions/withdraw", { suggestionId })).data;
}
