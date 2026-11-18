import { exchangeCode, refreshTokens } from "@/modules/agents/oauth";
import { LIMITS, rateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/request-ip";

/**
 * The token endpoint: swap a sign-in code (with its PKCE verifier) for an
 * access and refresh token, or a refresh token for a fresh pair. Accepts the
 * standard form encoding, and JSON for clients that send that.
 */
export async function POST(request: Request) {
  const limited = await rateLimit(`oauth-token:ip:${requestIp(request.headers)}`, LIMITS.oauthToken.limit, LIMITS.oauthToken.windowSeconds);
  if (!limited.ok) {
    return Response.json({ error: "slow_down", error_description: `Too many requests. Try again in ${limited.retryAfterSeconds} seconds.` }, {
      status: 429,
      headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" },
    });
  }
  const params = await readParams(request);
  if (!params) return tokenError("invalid_request", "Send the parameters as a form or JSON.");

  const grantType = params.get("grant_type");
  const clientId = params.get("client_id");
  if (!clientId) return tokenError("invalid_client", "client_id is required.", 401);

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const redirectUri = params.get("redirect_uri");
    const codeVerifier = params.get("code_verifier");
    if (!code || !redirectUri || !codeVerifier) {
      return tokenError("invalid_request", "code, redirect_uri and code_verifier are required.");
    }
    const result = await exchangeCode({ code, clientId, redirectUri, codeVerifier });
    if (!result.ok) return tokenError("invalid_grant", "The code is invalid, expired or already used.");
    return tokens(result);
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return tokenError("invalid_request", "refresh_token is required.");
    const result = await refreshTokens({ refreshToken, clientId });
    if (!result.ok) return tokenError("invalid_grant", "The refresh token is invalid, expired or revoked.");
    return tokens(result);
  }

  return tokenError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

async function readParams(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object") return null;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) if (typeof value === "string") params.set(key, value);
      return params;
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

function tokens(result: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return Response.json(
    {
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope,
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

function tokenError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });
}
