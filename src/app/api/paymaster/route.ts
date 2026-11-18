import { env } from "@/lib/env";
import { checkSponsorable } from "@/lib/chain/sponsor-policy";
import { isMemberWallet } from "@/modules/identity/wallet";

/**
 * Rallied's paymaster proxy (ERC-7677). The member's wallet (Coinbase's
 * window, not Rallied's page) asks here for Rallied to pay a transaction's
 * network fee. The real paymaster URL carries a secret key, so it never
 * leaves the server; this forwards only requests that qualify:
 *  - one of the two paymaster methods;
 *  - on Base Sepolia, calling only Rallied's contracts, carrying no money
 *    (see `sponsor-policy.ts`);
 *  - from a wallet that belongs to a Rallied member.
 * Anything else is refused without contacting the paymaster.
 */

const METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);

/** The wallet window runs on Coinbase's domain, so it needs to be allowed to call here. */
const WALLET_ORIGINS = new Set(["https://keys.coinbase.com", "https://keys-dev.coinbase.com"]);

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && WALLET_ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" }
    : {};
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function POST(request: Request) {
  const headers = { ...cors(request), "Cache-Control": "no-store" };
  const refuse = (id: unknown, message: string, status = 400) =>
    Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message } }, { status, headers });

  const upstream = env().PAYMASTER_URL;
  if (!upstream) return refuse(null, "Rallied isn't paying network fees right now.", 503);

  let body: { id?: unknown; method?: unknown; params?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return refuse(null, "Send a JSON-RPC request.");
  }
  if (typeof body.method !== "string" || !METHODS.has(body.method)) return refuse(body.id, "Method not allowed.");
  if (!Array.isArray(body.params)) return refuse(body.id, "Missing params.");

  const [userOp, , chainId] = body.params as unknown[];
  const check = checkSponsorable(userOp, chainId);
  if (!check.ok) return refuse(body.id, `Not sponsored: ${check.reason}.`, 403);
  if (!(await isMemberWallet(check.sender))) return refuse(body.id, "Not sponsored: not a Rallied member's wallet.", 403);

  let forwarded: Response;
  try {
    forwarded = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, method: body.method, params: body.params }),
      // The wallet window is waiting; don't hold it (or a server slot) open forever.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return refuse(body.id, "Rallied couldn't reach its paymaster. Try again.", 502);
  }
  return new Response(await forwarded.text(), {
    status: forwarded.status,
    headers: { ...headers, "content-type": "application/json" },
  });
}
