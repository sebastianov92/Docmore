export const OAUTH_SCOPES = ['read', 'write'] as const;
// The whole account, like a browser session. Only for Docmore's own apps (a
// docmore:// callback): it is never granted by default and the consent screen
// says so in plain words.
export const APP_SCOPE = 'app';
export const APP_REDIRECT_SCHEME = 'docmore:';
export type OAuthScopeName = (typeof OAUTH_SCOPES)[number] | typeof APP_SCOPE;

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
// Dynamic registrations per workspace; enough for a homelab's clients.
export const MAX_CLIENTS_PER_WORKSPACE = 500;

export const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
