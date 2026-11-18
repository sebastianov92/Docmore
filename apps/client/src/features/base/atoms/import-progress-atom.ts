import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { ImportProgress } from "@/features/base/csv-import/csv-import.types";

// Progress of the CSV import running on a base, fed by socket events and
// by polling the file task; null when nothing is running.
export const importProgressAtomFamily = atomFamily((_pageId: string) =>
  atom(null as ImportProgress | null),
);
