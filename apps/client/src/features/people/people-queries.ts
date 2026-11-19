import { useQuery } from "@tanstack/react-query";
import { getMemberProfile } from "@/features/people/people-service";
import { searchPage } from "@/features/search/services/search-service";

export function useMemberProfileQuery(userId: string | undefined) {
  return useQuery({
    queryKey: ["member-profile", userId],
    queryFn: () => getMemberProfile(userId!),
    enabled: !!userId,
  });
}

// Pages the person created, in spaces the viewer can see.
export function usePagesByCreatorQuery(userId: string | undefined) {
  return useQuery({
    queryKey: ["pages-by-creator", userId],
    queryFn: () => searchPage({ query: "", creatorId: userId, limit: 30 } as any),
    enabled: !!userId,
  });
}
