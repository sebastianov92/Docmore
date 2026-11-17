export interface OAuthAuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
  [key: string]: string | undefined;
}

export interface OAuthAuthorizeInfo {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  scopes: string[];
  redirectUri: string;
  verified: boolean;
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export const OAUTH_PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;
