import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// Drafts an AI prepares for its user, against a real migrated Postgres.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { draftSpend, draftRuleChange, draftRoleChange, listWaitingDrafts, discardDraft } = await import("./drafts");
const { setAiInGroup } = await import("./connection");
const { createGroup, grantAdmin } = await import("@/modules/groups/service");
const { users, groupMembers } = await import("@/lib/db/schema");
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
      before: "USDC 100 a month",
      after: "USDC 150 a month",
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
