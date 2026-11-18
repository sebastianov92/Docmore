import { atom } from "jotai";

// Set by the shared-page and public-space pages while they are mounted: a
// base embedded there reads through the public endpoints, read-only and
// without a socket subscription.
export type BasePublicContext = {
  shareId?: string;
  publicSpace?: boolean;
};

export const basePublicContextAtom = atom(null as BasePublicContext | null);
