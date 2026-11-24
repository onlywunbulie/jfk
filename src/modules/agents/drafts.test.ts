import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Drafts an AI prepares for its user, against a real migrated Postgres.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { draftSpend, draftRuleChange, draftRoleChange, draftGroupChange, listWaitingDrafts, discardDraft, countWaitingDrafts } = await import("@/modules/agents/drafts");
const { setAiInGroup } = await import("./connection");
const { createGroup, grantAdmin } = await import("@/modules/groups/service");
const { users, groupMembers, groups } = await import("@/lib/db/schema");
const { eq } = await import("drizzle-orm");

/** Put a group on Base, as Start on Base leaves it. */
const onBase = (groupId: string) =>
  t.db.update(groups).set({ safeAddress: "0x2a7a348bccee61c5ef6c213efc0baa05841a5a70" }).where(eq(groups.id, groupId));
const { Money } = await import("@/lib/money");

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

async function makeUser(name: string) {
  const [user] = await t.db.insert(users).values({ displayName: name }).returning();
  return user.id;
}

/** A group with the owner and extra members added directly. */
async function groupWith(owner: string, type: "TREASURY" | "ROTATING", others: string[] = []) {
  const { groupId } = await createGroup(owner, {
    name: "Detty December",
    type,
    contributionAmount: Money.fromMajor(100, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  for (const userId of others) await t.db.insert(groupMembers).values({ groupId, userId, role: "MEMBER", status: "ACTIVE" });
  return groupId;
}

const base = (userId: string, groupId: string) => ({ userId, groupId, madeBy: "Claude" });

describe("drafting a spend", () => {
  it("makes a waiting draft paid to a member, found by name in any case", async () => {
    const amaka = await makeUser("Amaka");
    const kemi = await makeUser("Kemi");
    const groupId = await groupWith(amaka, "TREASURY", [kemi]);

    const result = await draftSpend({ ...base(amaka, groupId), what: "Airbnb deposit", amount: "400", paidTo: "kemi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({ kind: "SPEND", status: "WAITING", madeBy: "Claude" });
    expect(result.draft.details).toMatchObject({ what: "Airbnb deposit", amountMinor: "400000000", currency: "USDC", paidTo: { kind: "member", name: "Kemi" } });
  });

  it("can pay someone outside the group by wallet address", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    const result = await draftSpend({ ...base(amaka, groupId), what: "Generator", amount: "150.50", paidTo: "0x4fCb4B8D0000000000000000000000000000ABcD" });
    expect(result.ok && result.draft.details.paidTo).toEqual({ kind: "address", address: "0x4fcb4b8d0000000000000000000000000000abcd", name: null });
  });

  it("refuses nonsense in plain words: unknown member, bad amount, http receipt", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    const unknown = await draftSpend({ ...base(amaka, groupId), what: "X", amount: "10", paidTo: "Nobody" });
    expect(unknown).toMatchObject({ ok: false });
    expect(!unknown.ok && unknown.reason).toContain('No member called "Nobody"');
    expect(await draftSpend({ ...base(amaka, groupId), what: "X", amount: "ten", paidTo: "Amaka" })).toMatchObject({ ok: false });
    expect(await draftSpend({ ...base(amaka, groupId), what: "X", amount: "0", paidTo: "Amaka" })).toMatchObject({ ok: false });
    expect(await draftSpend({ ...base(amaka, groupId), what: "X", amount: "10", paidTo: "Amaka", receiptUrl: "http://x.example" })).toMatchObject({
      ok: false,
    });
  });

  it("isn't possible in rotating savings, where every round's money already has a destination", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "ROTATING");
    const result = await draftSpend({ ...base(amaka, groupId), what: "X", amount: "10", paidTo: "Amaka" });
    expect(!result.ok && result.reason).toContain("rotating savings");
  });
});

describe("drafting a rule change", () => {
  it("records before → after for what everyone pays, starting next round", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    const result = await draftRuleChange({ ...base(amaka, groupId), rule: "what_everyone_pays", value: "150" });
    expect(result.ok && result.draft.details).toMatchObject({
      before: "$100.00 a month",
      after: "$150.00 a month",
      starts: "From the next round",
      money: true,
    });
  });

  it("refuses a change that changes nothing, or a day out of range", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "what_everyone_pays", value: "100" })).toMatchObject({ ok: false });
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "31" })).toMatchObject({ ok: false });
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "votes_count_share", value: "150" })).toMatchObject({ ok: false });
  });
});

describe("drafting a role change", () => {
  it("drafts making a member an admin", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY", [tunde]);
    const result = await draftRoleChange({ ...base(amaka, groupId), change: "make_admin", memberName: "Tunde" });
    expect(result.ok && result.draft.details).toMatchObject({ label: "Make Tunde an admin" });
  });

  it("refuses what doesn't fit: making yourself admin, removing an admin who isn't one", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY", [tunde]);
    expect(await draftRoleChange({ ...base(tunde, groupId), change: "make_admin", memberName: "Tunde" })).toMatchObject({ ok: false });
    expect(await draftRoleChange({ ...base(amaka, groupId), change: "remove_admin", memberName: "Tunde" })).toMatchObject({ ok: false });
  });

  it("allows removing an admin who is one", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY", [tunde]);
    await grantAdmin(groupId, amaka, tunde);
    expect((await draftRoleChange({ ...base(amaka, groupId), change: "remove_admin", memberName: "Tunde" })).ok).toBe(true);
  });
});

describe("counting what's waiting, for the sidebar", () => {
  it("counts the user's own waiting drafts per group and kind, and drops discarded ones", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY", [tunde]);
    const first = await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "5" });
    await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "6" });
    await draftRoleChange({ ...base(amaka, groupId), change: "make_admin", memberName: "Tunde" });
    if (!first.ok) throw new Error(first.reason);

    expect((await countWaitingDrafts(amaka)).get(groupId)).toEqual({ RULE_CHANGE: 2, ROLE_CHANGE: 1 });
    expect((await countWaitingDrafts(tunde)).get(groupId)).toBeUndefined();

    await discardDraft(amaka, first.draft.id);
    expect((await countWaitingDrafts(amaka)).get(groupId)).toEqual({ RULE_CHANGE: 1, ROLE_CHANGE: 1 });
  });
});

describe("who can draft, and who sees drafts", () => {
  it("only members, and not in a group the user kept their AI out of", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY");
    expect(await draftRuleChange({ ...base(tunde, groupId), rule: "due_day", value: "5" })).toMatchObject({ ok: false });

    await setAiInGroup(amaka, groupId, false);
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "5" })).toMatchObject({ ok: false });
  });

  it("drafts are private: only their owner sees or discards them", async () => {
    const amaka = await makeUser("Amaka");
    const tunde = await makeUser("Tunde");
    const groupId = await groupWith(amaka, "TREASURY", [tunde]);
    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "due_day", value: "5" });
    if (!made.ok) throw new Error(made.reason);

    expect(await listWaitingDrafts(tunde, groupId)).toEqual([]);
    expect(await discardDraft(tunde, made.draft.id)).toEqual({ ok: false, reason: "not_found" });

    expect((await listWaitingDrafts(amaka, groupId, "RULE_CHANGE")).map((d) => d.id)).toEqual([made.draft.id]);
    expect(await discardDraft(amaka, made.draft.id)).toEqual({ ok: true });
    expect(await listWaitingDrafts(amaka, groupId)).toEqual([]);
    // Already discarded: a second discard finds nothing.
    expect(await discardDraft(amaka, made.draft.id)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("the proposals beyond spends", () => {
  it("the share a decision needs: 50% to 100%, shown against today's rule", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "share_needed", value: "40" })).toMatchObject({ ok: false, reason: expect.stringContaining("Say which decision") });
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "share_needed", decision: "closing_the_group", value: "40" })).toMatchObject({ ok: false, reason: expect.stringContaining("50 to 100") });

    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "share_needed", decision: "closing_the_group", value: "90" });
    expect(made.ok && made.draft.details).toMatchObject({ ruleLabel: "Closing the group: share that must agree", before: "80%", after: "90%", value: "900", decision: "closing_the_group" });
  });

  it("how long votes stay open: 1 to 30 days", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    expect(await draftRuleChange({ ...base(amaka, groupId), rule: "vote_days", value: "45" })).toMatchObject({ ok: false });
    const made = await draftRuleChange({ ...base(amaka, groupId), rule: "vote_days", value: "5" });
    expect(made.ok && made.draft.details).toMatchObject({ before: "3 days", after: "5 days", value: "5" });
  });

  it("adding someone needs the group on Base and a real wallet that isn't already in", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "TREASURY");
    const add = (wallet: string) => draftRoleChange({ ...base(amaka, groupId), change: "add_member", memberName: "Tunde", wallet });
    expect(await add("0x1111111111111111111111111111111111111111")).toMatchObject({ ok: false, reason: expect.stringContaining("invite link") });

    await onBase(groupId);
    expect(await add("not a wallet")).toMatchObject({ ok: false, reason: expect.stringContaining("wallet address") });
    const made = await add("0x1111111111111111111111111111111111111111");
    expect(made.ok && made.draft.details).toMatchObject({ change: "add_member", label: "Add Tunde to the group", memberId: "", wallet: "0x1111111111111111111111111111111111111111" });
  });

  it("moving a member to a new wallet, found by name", async () => {
    const amaka = await makeUser("Amaka");
    const kemi = await makeUser("Kemi");
    const groupId = await groupWith(amaka, "TREASURY", [kemi]);
    await onBase(groupId);
    const made = await draftRoleChange({ ...base(amaka, groupId), change: "replace_wallet", memberName: "kemi", wallet: "0x2222222222222222222222222222222222222222" });
    expect(made.ok && made.draft.details).toMatchObject({ change: "replace_wallet", label: "Move Kemi to a new wallet", memberName: "Kemi" });
  });

  it("closing the group is a vote on Base; a group not on Base is deleted instead", async () => {
    const amaka = await makeUser("Amaka");
    const groupId = await groupWith(amaka, "ROTATING");
    expect(await draftGroupChange({ ...base(amaka, groupId), change: "close_group" })).toMatchObject({ ok: false, reason: expect.stringContaining("delete") });
    await onBase(groupId);
    const made = await draftGroupChange({ ...base(amaka, groupId), change: "close_group" });
    expect(made.ok && made.draft).toMatchObject({ kind: "GROUP_CHANGE", details: { change: "close_group", label: "Close Detty December" } });
  });
});

// The rotation as Base has it, for drafting a new payout order.
const rotationOnBase = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/modules/groups/onchain-rotation", () => ({ readRotation: async () => rotationOnBase.value }));

describe("drafting a new payout order", () => {
  /** A rotating group on Base: Amaka has collected; Kemi, Tunde and Bisi still to collect, in that order. */
  async function rotatingOnBase() {
    const amaka = await makeUser("Amaka");
    const kemi = await makeUser("Kemi");
    const tunde = await makeUser("Tunde");
    const bisi = await makeUser("Bisi");
    const groupId = await groupWith(amaka, "ROTATING", [kemi, tunde, bisi]);
    await t.db.update(groups).set({ safeAddress: "0x2a7a348bccee61c5ef6c213efc0baa05841a5a70", currency: "USDC" }).where(eq(groups.id, groupId));
    const seat = (userId: string) => ({ userId, name: "", wallet: "0x0", paidThisRound: false, collected: false, leaving: false, debt: 0n });
    rotationOnBase.value = { ok: true, cycle: 1, turn: 1, order: [seat(amaka), seat(kemi), seat(tunde), seat(bisi)], joining: [] };
    return { amaka, groupId };
  }

  it("drafts the same people still to collect, rearranged, found by name in any case", async () => {
    const { amaka, groupId } = await rotatingOnBase();
    const made = await draftGroupChange({ ...base(amaka, groupId), change: "change_order", order: ["bisi", "Kemi", "TUNDE"] });
    expect(made).toMatchObject({ ok: true });
    const [draft] = await listWaitingDrafts(amaka, groupId, "GROUP_CHANGE");
    expect(draft.details).toMatchObject({
      change: "change_order",
      label: "Change the payout order",
      detail: "Still to collect this cycle, in order: Bisi, Kemi, Tunde.",
    });
  });

  it("refuses someone who has already collected, a missing name, a repeat, or no change", async () => {
    const { amaka, groupId } = await rotatingOnBase();
    const order = (names: string[]) => draftGroupChange({ ...base(amaka, groupId), change: "change_order", order: names });
    expect(await order(["Amaka", "Kemi", "Tunde"])).toMatchObject({ ok: false, reason: expect.stringContaining("Amaka isn't still to collect") });
    expect(await order(["Bisi", "Kemi"])).toMatchObject({ ok: false, reason: expect.stringContaining("Name everyone still to collect") });
    expect(await order(["Bisi", "Bisi", "Kemi"])).toMatchObject({ ok: false, reason: expect.stringContaining("Name everyone still to collect") });
    expect(await order(["Kemi", "Tunde", "Bisi"])).toMatchObject({ ok: false, reason: "That's already the order." });
  });

  it("says plainly when there's no order on Base to change", async () => {
    const { amaka, groupId } = await rotatingOnBase();
    rotationOnBase.value = { ok: false, reason: "not_on_base" };
    expect(await draftGroupChange({ ...base(amaka, groupId), change: "change_order", order: ["Kemi"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("isn't on Base yet"),
    });
    const kemi = await makeUser("Kemi2");
    const pot = await groupWith(kemi, "TREASURY");
    expect(await draftGroupChange({ ...base(kemi, pot), change: "change_order", order: ["Kemi2"] })).toMatchObject({
      ok: false,
      reason: "Only a rotating group has a payout order.",
    });
  });
});
