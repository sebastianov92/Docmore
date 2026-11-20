import { getAppUrl } from "@/lib/config.ts";

export const SSO_ERROR_PARAM = "ssoError";

// Where the identity provider sends the browser back. Shown to admins so
// they can paste it into the provider's client settings.
export function buildOidcCallbackUrl(providerId: string): string {
  return `${getAppUrl()}/api/sso/oidc/${providerId}/callback`;
}

export function buildOidcLoginUrl(opts: {
  providerId: string;
  redirect?: string | null;
}): string {
  const base = `${getAppUrl()}/api/sso/oidc/${opts.providerId}/login`;
  if (!opts.redirect) return base;
  const params = new URLSearchParams({ redirect: opts.redirect });
  return `${base}?${params.toString()}`;
}

// The server reports a failed single sign-on by sending the browser to
// /login?ssoError=<message>.
export function readSsoError(search: string): string | null {
  const value = new URLSearchParams(search).get(SSO_ERROR_PARAM);
  if (!value) return null;
  return value.trim().slice(0, 300) || null;
}

// SAML: where the IdP posts the response, and our entity id (metadata).
export function buildSamlCallbackUrl(providerId: string): string {
  return `${getAppUrl()}/api/sso/saml/${providerId}/callback`;
}
export function buildSamlMetadataUrl(providerId: string): string {
  return `${getAppUrl()}/api/sso/saml/${providerId}/metadata`;
}

// Login entry point by provider type.
export function buildSsoLoginUrl(opts: { type: string; providerId: string; redirect?: string | null }): string {
  const kind = opts.type === "saml" ? "saml" : "oidc";
  const base = `${getAppUrl()}/api/sso/${kind}/${opts.providerId}/login`;
  if (!opts.redirect) return base;
  return `${base}?${new URLSearchParams({ redirect: opts.redirect }).toString()}`;
}
