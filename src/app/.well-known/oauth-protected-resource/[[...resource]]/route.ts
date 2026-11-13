import { agentUrls, publicOrigin } from "@/modules/agents/origin";
import { READ_SCOPE } from "@/modules/agents/oauth";

/**
 * Protected resource metadata (RFC 9728): tells an AI app that Rallied's MCP
 * endpoint is signed in to through Rallied's own authorization server. Served
 * at /.well-known/oauth-protected-resource and, for clients that append the
 * resource path, /.well-known/oauth-protected-resource/api/mcp.
 */
export function GET(request: Request) {
  const urls = agentUrls(publicOrigin(request.headers));
  return Response.json(
    {
      resource: urls.mcp,
      authorization_servers: [urls.issuer],
      scopes_supported: [READ_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Rallied",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
