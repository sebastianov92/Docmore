import { useMfaGate } from "@/features/mfa/hooks/use-mfa-gate.ts";
import { MfaChallengeForm } from "@/features/mfa/components/mfa-challenge-form.tsx";

export default function MfaChallengePage() {
  const { ready } = useMfaGate();

  if (!ready) {
    return null;
  }

  return <MfaChallengeForm />;
}
