import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMfaStatus } from "@/features/mfa/services/mfa-service.ts";

export const MFA_STATUS_KEY = ["mfa-status"];

export function useMfaStatusQuery() {
  return useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: getMfaStatus,
  });
}

export function useInvalidateMfaStatus() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
}
