import { env } from "@/lib/env";

/**
 * The address the outside world reaches Rallied at, for the URLs Claude is
 * given (discovery documents, the sign-in screen, the MCP endpoint).
 *
 * During testing that's a Cloudflare tunnel, so it's read from the request.
 * Only trusted hosts are believed: APP_URL's own host, or a quick tunnel
 * (*.trycloudflare.com) or an ngrok free domain. Anything else falls back to APP_URL, so a forged
 * Host header can't point Claude somewhere else.
 */
export function publicOrigin(headers: Headers): string {
  const configured = new URL(env().APP_URL);
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase();

  const trusted = host === configured.host || TUNNEL_HOST.test(host);
  if (!trusted) return configured.origin;

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : TUNNEL_HOST.test(host) ? "https" : configured.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Testing tunnels: a Cloudflare quick tunnel, an ngrok free domain, or a Tailscale Funnel (machine.tailnet.ts.net). Always HTTPS. */
const TUNNEL_HOST = /^[a-z0-9-]+\.(trycloudflare\.com|ngrok-free\.dev|ngrok-free\.app|[a-z0-9-]+\.ts\.net)$/;

/** The MCP endpoint and the documents that describe how to sign in to it. */
export function agentUrls(origin: string) {
  return {
    mcp: `${origin}/api/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
    issuer: origin,
    authorize: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    register: `${origin}/oauth/register`,
  };
}
