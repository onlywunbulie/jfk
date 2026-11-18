import { beforeEach, describe, expect, it, vi } from "vitest";

// The frame's per-group numbers, with Base replaced by a stand-in holding a
// few proposals whose state each test sets.
vi.mock("server-only", () => ({}));

const ME = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const SAFE = "0x2a7a348bccee61c5ef6c213efc0baa05841a5a70";
const now = () => BigInt(Math.floor(Date.now() / 1000));

interface Proposal {
  status: number;
  deadline: bigint;
  eligible: boolean;
  myVote: number;
}
const chain = { vault: 12_000_000n, proposals: [] as Proposal[], fail: false };

function read({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
  if (chain.fail) throw new Error("Base is down");
  const proposal = () => chain.proposals[Number(args[1]) - 1];
  switch (functionName) {
    case "getGroup":
      return ["0x0", 1_000_000n, 3 * 86400, 60, false, [], BigInt(chain.proposals.length)];
    case "balanceOf":
      return chain.vault;
    case "getProposal":
      return { status: proposal().status, deadline: proposal().deadline };
    case "eligibleVoter":
      return proposal().eligible;
    case "voteOf":
      return proposal().myVote;
    default:
      throw new Error(`unexpected read ${functionName}`);
  }
}
vi.mock("@/lib/chain/client", () => ({
  publicClient: () => ({
    multicall: async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[] }[] }) => contracts.map(read),
  }),
}));

const { chainSummaries } = await import("./onchain-summary");

beforeEach(() => {
  Object.assign(chain, { vault: 12_000_000n, proposals: [], fail: false });
});

describe("the frame's numbers for a group on Base", () => {
  it("counts only open votes, still before their deadline, that this member may cast and hasn't", async () => {
    const open = { status: 1, deadline: now() + 86_400n, eligible: true, myVote: 0 };
    chain.proposals = [
      open, // waiting for me
      { ...open, myVote: 1 }, // already voted
      { ...open, status: 2 }, // carried out
      { ...open, deadline: now() - 1n }, // closed
      { ...open, eligible: false }, // joined after it opened
      open, // waiting for me
    ];
    const summary = await chainSummaries([{ id: "g", safeAddress: SAFE }], ME);
    expect(summary.get("g")).toEqual({ vault: expect.stringContaining("12"), votesWaiting: 2 });
  });

  it("a group not on Base, or one Base can't answer for, is simply left out", async () => {
    expect((await chainSummaries([{ id: "g", safeAddress: null }], ME)).size).toBe(0);
    chain.fail = true;
    expect((await chainSummaries([{ id: "g", safeAddress: SAFE }], ME)).size).toBe(0);
  });

  it("without a wallet there's nothing to vote with, but the vault still shows", async () => {
    chain.proposals = [{ status: 1, deadline: now() + 86_400n, eligible: true, myVote: 0 }];
    expect((await chainSummaries([{ id: "g", safeAddress: SAFE }], null)).get("g")).toMatchObject({ votesWaiting: 0 });
  });
});
