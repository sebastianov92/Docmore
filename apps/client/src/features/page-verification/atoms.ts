import { atom } from "jotai";
import { ReviewChangesRequest } from "./types";

// The one locked page the user chose to edit anyway this session.
export const unlockedVerifiedPageIdAtom = atom<string | null>(null as string | null);

// Which page's review dialog is open, and what opened it.
export const reviewChangesAtom = atom<ReviewChangesRequest | null>(
  null as ReviewChangesRequest | null,
);
