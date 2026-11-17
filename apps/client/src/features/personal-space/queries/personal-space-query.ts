import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { ISpace } from "@/features/space/types/space.types";
import {
  createPersonalSpace,
  getPersonalSpace,
} from "@/features/personal-space/services/personal-space-service";

export const PERSONAL_SPACE_KEY = ["personal-space"];

export function usePersonalSpaceQuery(
  enabled = true,
): UseQueryResult<ISpace | null, Error> {
  return useQuery({
    queryKey: PERSONAL_SPACE_KEY,
    queryFn: getPersonalSpace,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreatePersonalSpaceMutation() {
  const queryClient = useQueryClient();

  return useMutation<ISpace, Error, { name?: string }>({
    mutationFn: createPersonalSpace,
    onSuccess: (space) => {
      queryClient.setQueryData(PERSONAL_SPACE_KEY, space);
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });
}
