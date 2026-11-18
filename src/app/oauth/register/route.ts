import { registerClient } from "@/modules/agents/oauth";
import { LIMITS, rateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/request-ip";

/**
 * Dynamic client registration (RFC 7591): an AI app like Claude introduces
 * itself and the exact addresses it may be sent back to. Public clients only:
 * no secret is issued, PKCE protects the code instead.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(`oauth-register:ip:${requestIp(request.headers)}`, LIMITS.oauthRegister.limit, LIMITS.oauthRegister.windowSeconds);
  if (!limited.ok) {
    return Response.json({ error: "slow_down", error_description: `Too many requests. Try again in ${limited.retryAfterSeconds} seconds.` }, {
      status: 429,
      headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "The body must be a JSON object.");
  }

  const result = await registerClient({ name: body.client_name, redirectUris: body.redirect_uris });
  if (!result.ok) {
    return oauthError(
      result.reason,
      result.reason === "invalid_redirect_uri" ? "redirect_uris must be 1 to 10 https addresses (or http on localhost)." : "Invalid client metadata.",
    );
  }

  return Response.json(
    {
      client_id: result.client.id,
      client_name: result.client.name,
      redirect_uris: result.client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(result.client.createdAt.getTime() / 1000),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

function oauthError(error: string, description: string) {
  return Response.json({ error, error_description: description }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
