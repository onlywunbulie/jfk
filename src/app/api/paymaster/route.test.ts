import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, numberToHex, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The paymaster proxy against a real database (for "is this a member's
// wallet"), with the real paymaster replaced by a stub that records calls.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("@/lib/env", () => ({
  env: () => ({ APP_URL: "http://localhost:3000", PAYMASTER_URL: "https://paymaster.example/secret-key" }),
}));

// Takes the URL and request like fetch; the tests read them back from mock.calls.
const upstream = vi.fn(async (..._fetchArgs: unknown[]) => Response.json({ jsonrpc: "2.0", id: 1, result: { paymasterAndData: "0x00" } }));
vi.stubGlobal("fetch", upstream);

const { POST, OPTIONS } = await import("./route");
const { users } = await import("@/lib/db/schema");
const { CONTRACTS, chain } = await import("@/lib/chain/addresses");

const MEMBER = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const STRANGER_WALLET = "0x1111111111111111111111111111111111111111";

const executeAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// A real member call (a vote) when it goes to Rallied's contract; anything else is refused anyway.
const VOTE = encodeFunctionData({
  abi: [{ type: "function", name: "vote", stateMutability: "nonpayable", inputs: [{ name: "safe", type: "address" }, { name: "id", type: "uint256" }, { name: "choice", type: "uint8" }], outputs: [] }] as const,
  functionName: "vote",
  args: ["0x2a7a348bccee61c5ef6c213efc0baa05841a5a70", 1n, 1],
});
const callTo = (target: `0x${string}`): Hex => encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [target, 0n, VOTE] });

function ask(sender: string, callData: Hex, method = "pm_getPaymasterStubData", origin = "https://keys.coinbase.com") {
  return POST(
    new Request("http://localhost:3000/api/paymaster", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method,
        params: [{ sender, callData }, "0x0000000071727De22E5E9d8BAf0edAc6f37da032", numberToHex(chain.id), {}],
      }),
    }),
  );
}

beforeEach(async () => {
  await t.reset();
  upstream.mockClear();
  await t.db.insert(users).values({ displayName: "Amaka", walletAddress: MEMBER });
});

afterAll(async () => {
  await t.close();
});

describe("/api/paymaster", () => {
  it("forwards a member's call to Rallied's contract, without revealing the real paymaster", async () => {
    const response = await ask(MEMBER, callTo(CONTRACTS.jfkModule));
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0][0])).toBe("https://paymaster.example/secret-key");
    expect(await response.text()).not.toContain("secret-key");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://keys.coinbase.com");
  });

  it("refuses a wallet that isn't a Rallied member's, without asking the paymaster", async () => {
    const response = await ask(STRANGER_WALLET, callTo(CONTRACTS.jfkModule));
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a call to any other contract", async () => {
    const response = await ask(MEMBER, callTo("0x2222222222222222222222222222222222222222"));
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses any other JSON-RPC method", async () => {
    const response = await ask(MEMBER, callTo(CONTRACTS.jfkModule), "eth_sendRawTransaction");
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("only lets Coinbase's wallet window call it from a browser", async () => {
    const preflight = OPTIONS(new Request("http://localhost:3000/api/paymaster", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const fromWallet = OPTIONS(new Request("http://localhost:3000/api/paymaster", { method: "OPTIONS", headers: { origin: "https://keys.coinbase.com" } }));
    expect(fromWallet.headers.get("access-control-allow-origin")).toBe("https://keys.coinbase.com");
  });
});
