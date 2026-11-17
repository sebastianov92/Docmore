import api from "@/lib/api-client";
import {
  IMfaAccess,
  IMfaEnabled,
  IMfaSetup,
  IMfaStatus,
} from "@/features/mfa/types/mfa.types.ts";

export async function getMfaStatus(): Promise<IMfaStatus> {
  const req = await api.post<IMfaStatus>("/mfa/status");
  return req.data;
}

export async function setupMfa(): Promise<IMfaSetup> {
  const req = await api.post<IMfaSetup>("/mfa/setup", { method: "totp" });
  return req.data;
}

export async function enableMfa(verificationCode: string): Promise<IMfaEnabled> {
  const req = await api.post<IMfaEnabled>("/mfa/enable", { verificationCode });
  return req.data;
}

export async function disableMfa(confirmPassword?: string): Promise<void> {
  await api.post("/mfa/disable", confirmPassword ? { confirmPassword } : {});
}

export async function regenerateBackupCodes(
  confirmPassword?: string,
): Promise<{ backupCodes: string[] }> {
  const req = await api.post<{ backupCodes: string[] }>(
    "/mfa/generate-backup-codes",
    confirmPassword ? { confirmPassword } : {},
  );
  return req.data;
}

export async function verifyMfa(code: string): Promise<void> {
  await api.post("/mfa/verify", { code });
}

export async function validateMfaAccess(): Promise<IMfaAccess> {
  try {
    const req = await api.post<IMfaAccess>("/mfa/validate-access");
    return req.data;
  } catch {
    return { valid: false };
  }
}
