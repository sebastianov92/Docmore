export const OAUTH_SCOPES = ['read', 'write'] as const;
export type OAuthScopeName = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
// Dynamic registrations per workspace; enough for a homelab's clients.
export const MAX_CLIENTS_PER_WORKSPACE = 500;

export const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
