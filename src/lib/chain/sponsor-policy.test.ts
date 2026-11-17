import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, numberToHex, type Address, type Hex } from "viem";
import { CONTRACTS, chain } from "./addresses";
import { checkSponsorable } from "./sponsor-policy";

// The same two calls Base Account (Coinbase Smart Wallet) wraps operations in.
const walletAbi = [
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
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const SENDER = getAddress("0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129");
const STRANGER = getAddress("0x00000000000000000000000000000000deadbeef");
const BASE_SEPOLIA = numberToHex(chain.id);

const one = (target: Address, value = 0n): Hex => encodeFunctionData({ abi: walletAbi, functionName: "execute", args: [target, value, "0x1234"] });
const many = (targets: Address[]): Hex =>
  encodeFunctionData({ abi: walletAbi, functionName: "executeBatch", args: [targets.map((target) => ({ target, value: 0n, data: "0x" as Hex }))] });

describe("what Rallied pays the network fee for", () => {
  it("a call to Rallied's contract, on Base Sepolia, from a wallet", () => {
    expect(checkSponsorable({ sender: SENDER, callData: one(CONTRACTS.jfkModule) }, BASE_SEPOLIA)).toEqual({ ok: true, sender: SENDER });
  });

  it("a batch that only touches Rallied's contracts (e.g. approve USDC, then a module call)", () => {
    expect(checkSponsorable({ sender: SENDER, callData: many([CONTRACTS.usdc, CONTRACTS.jfkModule]) }, BASE_SEPOLIA).ok).toBe(true);
  });

  it("not a call to any other contract, even inside an otherwise fine batch", () => {
    expect(checkSponsorable({ sender: SENDER, callData: one(STRANGER) }, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(checkSponsorable({ sender: SENDER, callData: many([CONTRACTS.jfkModule, STRANGER]) }, BASE_SEPOLIA)).toMatchObject({ ok: false });
  });

  it("not a call that sends money along with it", () => {
    expect(checkSponsorable({ sender: SENDER, callData: one(CONTRACTS.jfkModule, 1n) }, BASE_SEPOLIA)).toEqual({ ok: false, reason: "sends money" });
  });

  it("not on any other network", () => {
    expect(checkSponsorable({ sender: SENDER, callData: one(CONTRACTS.jfkModule) }, numberToHex(8453))).toEqual({ ok: false, reason: "wrong network" });
  });

  it("not a wallet call it can't read, or a malformed request", () => {
    expect(checkSponsorable({ sender: SENDER, callData: "0xdeadbeef" }, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(checkSponsorable({ sender: "nope", callData: one(CONTRACTS.jfkModule) }, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(checkSponsorable(null, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(checkSponsorable({ sender: SENDER, callData: many([]) }, BASE_SEPOLIA)).toEqual({ ok: false, reason: "nothing to do" });
  });
});
