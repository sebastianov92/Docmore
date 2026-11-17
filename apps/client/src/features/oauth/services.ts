import api from "@/lib/api-client";
import { OAUTH_PARAM_NAMES, OAuthAuthorizeInfo, OAuthAuthorizeParams, OAuthGrant } from "./types";

// Only the OAuth parameters travel to the server; anything else in the
// query string is ignored.
export function pickOAuthParams(params: OAuthAuthorizeParams): OAuthAuthorizeParams {
  const picked: OAuthAuthorizeParams = {};
  for (const name of OAUTH_PARAM_NAMES) {
    if (params[name] !== undefined) picked[name] = params[name];
  }
  return picked;
}

export async function getAuthorizeInfo(params: OAuthAuthorizeParams): Promise<OAuthAuthorizeInfo> {
  const req = await api.post<OAuthAuthorizeInfo>("/oauth/authorize-info", pickOAuthParams(params));
  return req.data;
}

export async function decideAuthorization(
  params: OAuthAuthorizeParams,
  decision: { approved: true; approvedScopes: string[] } | { approved: false },
): Promise<{ redirectUrl: string }> {
  const req = await api.post<{ redirectUrl: string }>("/oauth/authorize", { ...pickOAuthParams(params), ...decision });
  return req.data;
}

export async function getOAuthGrants(): Promise<OAuthGrant[]> {
  const req = await api.post<OAuthGrant[]>("/oauth/grants", {});
  return req.data;
}

export async function revokeOAuthGrant(grantId: string): Promise<void> {
  await api.post("/oauth/grants/revoke", { grantId });
}
