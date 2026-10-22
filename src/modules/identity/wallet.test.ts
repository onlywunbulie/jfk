import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverMessageAddress, type Hex } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

// The real check asks the chain. Here it recovers the signer locally, which is
// exactly what the chain does for an ordinary (non-contract) wallet.
vi.mock("./wallet-signature", () => ({
  verifyWalletSignature: async ({
    address,
    message,
    signature,
  }: {
    address: string;
    message: string;
    signature: Hex;
  }) => {
    const signer = await recoverMessageAddress({ message, signature });
    return signer.toLowerCase() === address.toLowerCase();
  },
}));

const { signInWithWallet, setDisplayName } = await import("./wallet");
const { users } = await import("@/lib/db/schema");

const HOST = "localhost:3000";
const NONCE = "abcdef1234567890";
const NOW = new Date("2026-10-22T12:00:00Z");

async function signed(
  overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {},
  key = generatePrivateKey(),
) {
  const account = privateKeyToAccount(key);
  const message = createSiweMessage({
    address: account.address,
    chainId: 84532,
    domain: HOST,
    nonce: NONCE,
    uri: `http://${HOST}`,
    version: "1",
    issuedAt: NOW,
    expirationTime: new Date(NOW.getTime() + 10 * 60_000),
    ...overrides,
  });
  const signature = await account.signMessage({ message });
  return { account, message, signature };
}

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

describe("signing in with a wallet", () => {
  it("creates a member the first time, with a placeholder name", async () => {
    const { account, message, signature } = await signed();

    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });

    expect(result).toMatchObject({ ok: true, isNewUser: true, address: account.address.toLowerCase() });
    const [row] = await t.db.select().from(users);
    expect(row.walletAddress).toBe(account.address.toLowerCase());
    expect(row.email).toBeNull();
    expect(row.displayName).toMatch(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  });

  it("finds the same member the next time", async () => {
    const key = generatePrivateKey();
    const first = await signed({}, key);
    const second = await signed({}, key);

    const a = await signInWithWallet({ ...first, host: HOST, expectedNonce: NONCE, now: NOW });
    const b = await signInWithWallet({ ...second, host: HOST, expectedNonce: NONCE, now: NOW });

    expect(b).toMatchObject({ ok: true, isNewUser: false });
    expect(a.ok && b.ok && a.userId === b.userId).toBe(true);
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  it("refuses a signature from a different wallet than the message names", async () => {
    const { message } = await signed();
    const impostor = privateKeyToAccount(generatePrivateKey());
    const signature = await impostor.signMessage({ message });

    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    expect(await t.db.select().from(users)).toHaveLength(0);
  });

  it("refuses a message signed for another site", async () => {
    const { message, signature } = await signed({ domain: "evil.example" });
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "wrong_site" });
  });

  it("refuses a message for another network", async () => {
    const { message, signature } = await signed({ chainId: 8453 });
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "wrong_network" });
  });

  it("refuses a replayed or unrequested sign-in", async () => {
    const { message, signature } = await signed();
    expect(
      await signInWithWallet({ message, signature, host: HOST, expectedNonce: "someothernonce1", now: NOW }),
    ).toEqual({ ok: false, reason: "wrong_nonce" });
    expect(
      await signInWithWallet({ message, signature, host: HOST, expectedNonce: null, now: NOW }),
    ).toEqual({ ok: false, reason: "wrong_nonce" });
  });

  it("refuses an expired message", async () => {
    const { message, signature } = await signed();
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: later });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses something that isn't a sign-in message at all", async () => {
    const result = await signInWithWallet({
      message: "hello",
      signature: "0x00",
      host: HOST,
      expectedNonce: NONCE,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "unreadable_message" });
  });
});

describe("Base Account's shorter sign-in message", () => {
  // The exact shape Base Account produced in testing on 22 October 2026: no
  // Version or Issued At, and the site named without its port.
  async function baseAccountMessage(overrides: { domain?: string; uri?: string; chainId?: number } = {}) {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = [
      `${overrides.domain ?? "localhost"} wants you to sign in with your Ethereum account:`,
      account.address,
      "",
      `URI: ${overrides.uri ?? "http://localhost:3000"}`,
      `Chain ID: ${overrides.chainId ?? 84532}`,
      `Nonce: ${NONCE}`,
    ].join("\n");
    return { account, message, signature: await account.signMessage({ message }) };
  }

  it("is accepted", async () => {
    const { account, message, signature } = await baseAccountMessage();
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toMatchObject({ ok: true, isNewUser: true, address: account.address.toLowerCase() });
  });

  it("is refused when its URI points at another site", async () => {
    const { message, signature } = await baseAccountMessage({ uri: "http://localhost:4000" });
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "wrong_site" });
  });

  it("is refused when it names another site", async () => {
    const { message, signature } = await baseAccountMessage({ domain: "evil.example", uri: "http://evil.example" });
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "wrong_site" });
  });

  it("is refused on another network", async () => {
    const { message, signature } = await baseAccountMessage({ chainId: 8453 });
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    expect(result).toEqual({ ok: false, reason: "wrong_network" });
  });
});

describe("choosing a name", () => {
  it("tidies whitespace and refuses empty or overlong names", async () => {
    const { message, signature } = await signed();
    const result = await signInWithWallet({ message, signature, host: HOST, expectedNonce: NONCE, now: NOW });
    if (!result.ok) throw new Error("sign-in failed");

    expect(await setDisplayName(result.userId, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(await setDisplayName(result.userId, "x".repeat(41))).toEqual({ ok: false, reason: "too_long" });
    expect(await setDisplayName(result.userId, "  Amaka   Eze ")).toEqual({ ok: true });

    const [row] = await t.db.select().from(users);
    expect(row.displayName).toBe("Amaka Eze");
  });
});
