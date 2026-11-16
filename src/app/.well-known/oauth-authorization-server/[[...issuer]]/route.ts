import { agentUrls, publicOrigin } from "@/modules/agents/origin";
import { DRAFT_SCOPE, READ_SCOPE } from "@/modules/agents/oauth";

/**
 * Authorization server metadata (RFC 8414): where an AI app registers, sends
 * the user to approve, and swaps the code for tokens. Public clients only
 * (no client secret), authorization code with PKCE S256, refresh tokens.
 */
export function GET(request: Request) {
  const urls = agentUrls(publicOrigin(request.headers));
  return Response.json(
    {
      issuer: urls.issuer,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      registration_endpoint: urls.register,
      scopes_supported: [READ_SCOPE, DRAFT_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
