import { getClient } from "@/modules/agents/oauth";
import type { OauthClient } from "@/lib/db/schema";

/**
 * Checking an AI app's sign-in request. Kept out of the "use server" file so
 * the page and the actions share it.
 *
 * Order matters (OAuth 2.1 §4.1.2.1): if the app or its return address is
 * wrong, show an error here and never redirect, since that address can't be
 * trusted. Only once both are right are other problems sent back to the app.
 */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
}

export type AuthorizeCheck =
  | { ok: true; client: OauthClient; request: AuthorizeRequest }
  | { ok: false; showHere: string }
  | { ok: false; sendBack: URL };

export async function checkAuthorizeRequest(params: Record<string, string | undefined>): Promise<AuthorizeCheck> {
  const clientId = params.client_id;
  const redirectUri = params.redirect_uri;
  if (!clientId || !redirectUri) return { ok: false, showHere: "This sign-in link is incomplete. Start again from your AI app." };

  const client = await getClient(clientId);
  if (!client) return { ok: false, showHere: "Rallied doesn't recognise this app. Remove the connector and add it again." };
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, showHere: "This app asked to return somewhere it didn't register. For your safety, nothing was shared." };
  }

  const state = params.state ?? null;
  const back = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return { ok: false as const, sendBack: url };
  };

  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return back("invalid_request", "code_challenge is malformed.");

  return {
    ok: true,
    client,
    request: { clientId, redirectUri, codeChallenge: params.code_challenge, state, scope: "groups:read" },
  };
}

/** Where to send the app back after a decision. */
export function backTo(redirectUri: string, values: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  return url.toString();
}
