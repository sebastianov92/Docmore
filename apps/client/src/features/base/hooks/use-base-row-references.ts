import { useMemo } from "react";
import { InfiniteData, useQueryClient } from "@tanstack/react-query";
import { IPagination } from "@/lib/types";
import { IBaseRow, ReferenceUser, RowReferences } from "@/features/base/types/base.types";

// People and pages named by the rows already loaded for a base: the server
// sends them with every page of rows, so cells can show names without a
// member list (public readers have none).
export function useBaseRowReferences(pageId: string | undefined): RowReferences {
  const queryClient = useQueryClient();
  const cached = queryClient.getQueriesData<InfiniteData<IPagination<IBaseRow> & { references?: RowReferences }>>({
    queryKey: ["base-rows", pageId],
  });
  return useMemo(() => {
    const users: Record<string, ReferenceUser> = {};
    const pages: RowReferences["pages"] = {};
    const rows: NonNullable<RowReferences["rows"]> = {};
    for (const [, data] of cached) {
      for (const page of data?.pages ?? []) {
        Object.assign(users, page.references?.users ?? {});
        Object.assign(pages, page.references?.pages ?? {});
        Object.assign(rows, page.references?.rows ?? {});
      }
    }
    return { users, pages, rows };
    // the cache snapshot changes identity on every render; fold it by content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cached.map(([k]) => k)), cached.length, pageId]);
}
