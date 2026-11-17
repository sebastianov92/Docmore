export interface IMfaStatus {
  isEnabled: boolean;
  method: string | null;
  backupCodesCount: number;
}

export interface IMfaSetup {
  method: string;
  // data: URL of the QR code for the authenticator app
  qrCode: string;
  // base32 secret for typing it in by hand
  manualKey: string;
}

export interface IMfaEnabled {
  success: boolean;
  backupCodes: string[];
  // set when the setup happened during an enforced login: the session is already open
  loggedIn?: boolean;
}

export interface IMfaAccess {
  valid: boolean;
  isTransferToken?: boolean;
  userHasMfa?: boolean;
  requiresMfaSetup?: boolean;
  isMfaEnforced?: boolean;
}
