// Docmore ships OpenID Connect only. The type stays a union so the login
// button list can grow without touching callers.
export type SsoProviderType = "oidc";

// What the login page gets from /workspace/public: enough to draw a button.
export interface IPublicAuthProvider {
  id: string;
  name: string;
  type: SsoProviderType | string;
}

export interface ISsoProvider {
  id: string;
  name: string;
  type: SsoProviderType;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  // The secret itself never reaches the browser.
  hasOidcClientSecret: boolean;
  allowSignup: boolean;
  isEnabled: boolean;
  groupSync: boolean;
  creatorId: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ICreateSsoProvider {
  type: SsoProviderType;
  name?: string;
}

export interface IUpdateSsoProvider {
  providerId: string;
  name?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  allowSignup?: boolean;
  isEnabled?: boolean;
  groupSync?: boolean;
}
