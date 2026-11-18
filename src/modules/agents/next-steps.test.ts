import { beforeEach, describe, expect, it, vi } from "vitest";

// What the user's AI offers next, from where a group stands. Base and the
// drafts are stand-ins whose state each test sets.
vi.mock("server-only", () => ({}));

const state = {
  drafts: new Map<string, Partial<Record<string, number>>>(),
  canVote: false,
  paid: false,
  autopay: false,
};
vi.mock("@/modules/agents/drafts", () => ({ countWaitingDrafts: async () => state.drafts }));
vi.mock("@/modules/groups/onchain-votes", () => ({
  readChainVotes: async () => ({ ok: true, safe: "0x", votes: state.canVote ? [{ title: "What everyone pays", canVote: true }] : [] }),
}));
vi.mock("@/modules/groups/onchain-dues", () => ({
  readDues: async () => ({ ok: true, you: { paidThisPeriod: state.paid ? "Paid 17 Nov" : null } }),
}));
vi.mock("@/modules/groups/onchain-autopay", () => ({
  autopayStatus: async () => (state.autopay ? { on: true, until: "18 November 2027" } : { on: false, why: "never_set_up" }),
}));

const { nextForGroup, nextAcrossGroups } = await import("./next-steps");

const otf = { id: "g1", name: "OTF", type: "TREASURY" as const, role: "OWNER", safeAddress: "0xabc" };

beforeEach(() => {
  Object.assign(state, { drafts: new Map(), canVote: false, paid: false, autopay: false });
});

describe("what the AI offers next for one group", () => {
  it("a group not on Base: invite friends, or start it on Base (for its starter)", async () => {
    expect(await nextForGroup("u", { ...otf, safeAddress: null })).toEqual(["Invite friends to OTF", "Start OTF on Base"]);
    expect(await nextForGroup("u", { ...otf, safeAddress: null, role: "MEMBER" })).toEqual(["What's happening in OTF?"]);
  });

  it("what needs the user comes first: a waiting draft, then their vote, then unpaid dues", async () => {
    state.drafts.set("g1", { RULE_CHANGE: 1 });
    state.canVote = true;
    expect(await nextForGroup("u", otf)).toEqual(["Open my waiting draft in OTF", 'Open the vote on "What everyone pays"', "Pay my OTF dues now"]);
  });

  it("unpaid and not automatic: pay now, or automatically", async () => {
    expect((await nextForGroup("u", otf)).slice(0, 2)).toEqual(["Pay my OTF dues now", "Pay my OTF dues automatically"]);
  });

  it("all settled: the useful things to do, never more than three", async () => {
    state.paid = true;
    state.autopay = true;
    const steps = await nextForGroup("u", otf);
    expect(steps).toEqual(["Propose a spend from OTF", "How much is in OTF's pot?"]);
    expect(steps.length).toBeLessThanOrEqual(3);
  });

  it("steps an action puts first stay first, without repeats", async () => {
    const steps = await nextForGroup("u", otf, ["Open it to send to a vote", "Pay my OTF dues now"]);
    expect(steps[0]).toBe("Open it to send to a vote");
    expect(new Set(steps).size).toBe(steps.length);
  });
});

describe("what the AI offers across all the user's groups", () => {
  it("waiting drafts, then groups to start on Base, then a look or a new group", async () => {
    state.drafts.set("g1", { SPEND: 2 });
    const steps = await nextAcrossGroups("u", [otf, { ...otf, id: "g2", name: "Weekend", safeAddress: null }]);
    expect(steps).toEqual(["Open my waiting draft in OTF", "Start Weekend on Base", "What's happening in OTF?"]);
  });

  it("no groups yet: make one", async () => {
    expect(await nextAcrossGroups("u", [])).toEqual(["Create a new group"]);
  });
});
