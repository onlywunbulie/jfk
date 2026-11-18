import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, numberToHex, type Address, type Hex } from "viem";
import { CONTRACTS, chain } from "./addresses";
import { checkSponsorable } from "./sponsor-policy";
import { erc20Abi, jfkDuesAbi, jfkHelperAbi, jfkModuleAbi } from "./abis";

const transferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

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

/** Real calls, as Rallied asks members' wallets to send them. */
const SAFE = getAddress("0x2a7a348bccee61c5ef6c213efc0baa05841a5a70");
const VOTE = encodeFunctionData({ abi: jfkModuleAbi, functionName: "vote", args: [SAFE, 1n, 1] });
const PROPOSE = encodeFunctionData({ abi: jfkModuleAbi, functionName: "propose", args: [SAFE, 4, "0x"] });
const CONTRIBUTE = encodeFunctionData({ abi: jfkDuesAbi, functionName: "contribute", args: [SAFE] });
const SET_HELPER = encodeFunctionData({ abi: jfkHelperAbi, functionName: "setHelper", args: [SAFE, STRANGER, 4, 1n] });
const APPROVE_MODULE = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACTS.jfkModule, 1_000_000n] });

type Call = { target: Address; data: Hex; value?: bigint };
const one = ({ target, data, value = 0n }: Call): Hex => encodeFunctionData({ abi: walletAbi, functionName: "execute", args: [target, value, data] });
const many = (calls: Call[]): Hex =>
  encodeFunctionData({ abi: walletAbi, functionName: "executeBatch", args: [calls.map((call) => ({ target: call.target, value: call.value ?? 0n, data: call.data }))] });
const ask = (callData: Hex, chainId: string = BASE_SEPOLIA) => checkSponsorable({ sender: SENDER, callData }, chainId);
const toModule = (data: Hex): Call => ({ target: CONTRACTS.jfkModule, data });

describe("what Rallied pays the network fee for", () => {
  it("the member-side calls to Rallied's contract: propose, vote, contribute, name a helper", () => {
    for (const data of [VOTE, PROPOSE, CONTRIBUTE, SET_HELPER]) expect(ask(one(toModule(data)))).toEqual({ ok: true, sender: SENDER });
  });

  it("approving USDC for Rallied's contract, then paying in, as one batch", () => {
    expect(ask(many([{ target: CONTRACTS.usdc, data: APPROVE_MODULE }, toModule(CONTRIBUTE)])).ok).toBe(true);
  });

  it("not any other USDC call: no transfers, no approving anyone else", () => {
    const transfer = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [STRANGER, 1_000_000n] });
    const approveStranger = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STRANGER, 1_000_000n] });
    expect(ask(one({ target: CONTRACTS.usdc, data: transfer }))).toMatchObject({ ok: false });
    expect(ask(one({ target: CONTRACTS.usdc, data: approveStranger }))).toMatchObject({ ok: false, reason: expect.stringContaining("someone other") });
  });

  it("not Rallied's contract functions members never send (carrying out, collecting), or unknown ones", () => {
    const execute = encodeFunctionData({ abi: jfkModuleAbi, functionName: "execute", args: [SAFE, 1n] });
    const collect = encodeFunctionData({ abi: jfkHelperAbi, functionName: "collect", args: [SAFE, SENDER] });
    expect(ask(one(toModule(execute)))).toMatchObject({ ok: false });
    expect(ask(one(toModule(collect)))).toMatchObject({ ok: false });
    expect(ask(one(toModule("0xdeadbeef")))).toMatchObject({ ok: false });
  });

  it("not Safe's factory or any other contract, even inside an otherwise fine batch", () => {
    expect(ask(one({ target: CONTRACTS.safeProxyFactory, data: "0x1234" }))).toMatchObject({ ok: false });
    expect(ask(one({ target: STRANGER, data: "0x" }))).toMatchObject({ ok: false });
    expect(ask(many([toModule(VOTE), { target: STRANGER, data: "0x" }]))).toMatchObject({ ok: false });
  });

  it("not a call that sends money along with it", () => {
    expect(ask(one({ ...toModule(VOTE), value: 1n }))).toEqual({ ok: false, reason: "sends money" });
  });

  it("not on any other network", () => {
    expect(ask(one(toModule(VOTE)), numberToHex(8453))).toEqual({ ok: false, reason: "wrong network" });
  });

  it("not a wallet call it can't read, or a malformed request", () => {
    expect(ask("0xdeadbeef")).toMatchObject({ ok: false });
    expect(checkSponsorable({ sender: "nope", callData: one(toModule(VOTE)) }, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(checkSponsorable(null, BASE_SEPOLIA)).toMatchObject({ ok: false });
    expect(ask(many([]))).toEqual({ ok: false, reason: "nothing to do" });
  });
});
