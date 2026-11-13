import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyAccessToken } from "@/modules/agents/oauth";
import { buildRalliedServer } from "@/modules/agents/mcp";
import { agentUrls, publicOrigin } from "@/modules/agents/origin";

/**
 * Rallied's MCP endpoint (Streamable HTTP, stateless). Every request must
 * carry a bearer token from Rallied's sign-in; without one the answer is 401
 * with a pointer to how to sign in, which is how Claude discovers the flow.
 * Each request gets a fresh server with the token's user baked in.
 */
async function handle(request: Request): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const grant = token ? await verifyAccessToken(token) : null;

  if (!grant) {
    const urls = agentUrls(publicOrigin(request.headers));
    return Response.json(
      { error: "invalid_token", error_description: "Sign in to Rallied to use this." },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${urls.resourceMetadata}"${token ? ', error="invalid_token"' : ""}`,
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const server = buildRalliedServer(grant.userId);
  // Stateless: no session ids, one JSON response per request.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // Say why a request was refused (e.g. an unknown protocol version), so a 400 in the log isn't a mystery.
  transport.onerror = (error) => console.warn(`[mcp] ${error.message}`);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
