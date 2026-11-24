import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// After a vote is carried out on Base, Rallied's records follow it. Real
// database; the payloads are exactly what the contract carried out.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const { applyOnRallied } = await import("@/modules/groups/onchain-apply");
const { createGroup } = await import("@/modules/groups/service");
const { users, groups, groupMembers, groupSettings, governanceRules } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");
const { and, eq } = await import("drizzle-orm");

const AMAKA = "0x27c73a4bdc1ca98cafb44cf33ab8c681db2bd129";
const KEMI = "0x4596a149ac1d950ba229b208445dcb51fc84182b";
const KEMI_NEW = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const one = (wallet: string) => encodeAbiParameters([{ type: "address" }], [wallet as `0x${string}`]);

beforeEach(async () => {
  await t.reset();
});
afterAll(async () => {
  await t.close();
});

async function setup() {
  const [amaka] = await t.db.insert(users).values({ displayName: "Amaka", walletAddress: AMAKA }).returning();
  const [kemi] = await t.db.insert(users).values({ displayName: "Kemi", walletAddress: KEMI }).returning();
  const { groupId } = await createGroup(amaka.id, {
    name: "Detty December",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(10, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: kemi.id, role: "MEMBER", status: "ACTIVE" });
  return { groupId, amaka: amaka.id, kemi: kemi.id };
}

const membership = async (groupId: string, userId: string) =>
  (await t.db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))))[0];

describe("Rallied follows what Base carried out", () => {
  it("a member voted out is out of the group in Rallied too", async () => {
    const { groupId, kemi } = await setup();
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "REMOVE_MEMBER", one(KEMI)));
    expect((await membership(groupId, kemi)).status).toBe("REMOVED");
  });

  it("someone voted in with a Rallied account joins; a wallet with no account changes nothing", async () => {
    const { groupId, kemi } = await setup();
    await t.db.update(groupMembers).set({ status: "LEFT" }).where(eq(groupMembers.userId, kemi));
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "ADD_MEMBER", one(KEMI)));
    expect((await membership(groupId, kemi)).status).toBe("ACTIVE");

    const before = await t.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "ADD_MEMBER", one(STRANGER)));
    expect(await t.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId))).toHaveLength(before.length);
  });

  it("a lost wallet replaced: the member's place moves to their new account", async () => {
    const { groupId, kemi } = await setup();
    const [kemiNew] = await t.db.insert(users).values({ displayName: "Kemi (new phone)", walletAddress: KEMI_NEW }).returning();
    const payload = encodeAbiParameters([{ type: "address" }, { type: "address" }], [KEMI, KEMI_NEW]);
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "REPLACE_MEMBER", payload));
    expect(await membership(groupId, kemi)).toBeUndefined();
    expect((await membership(groupId, kemiNew.id)).status).toBe("ACTIVE");
  });

  it("a closed group is closed", async () => {
    const { groupId } = await setup();
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "CLOSE_GROUP", "0x"));
    expect((await t.db.select().from(groups).where(eq(groups.id, groupId)))[0].status).toBe("DISSOLVED");
  });

  it("new rules: the share each decision needs, turnout and how long votes stay open", async () => {
    const { groupId } = await setup();
    const thresholds = [600, 700, 500, 800, 750, 900, 850, 950, 850] as const;
    const payload = encodeAbiParameters(
      [{ type: "uint16[9]" }, { type: "uint8" }, { type: "uint32" }, { type: "bool" }],
      [thresholds, 70, 5 * 86_400, true],
    );
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "CHANGE_RULES", payload));

    const [settings] = await t.db.select().from(groupSettings).where(eq(groupSettings.groupId, groupId));
    expect(settings).toMatchObject({ quorumPct: 70, defaultVoteDays: 5 });
    const rules = Object.fromEntries(
      (await t.db.select().from(governanceRules).where(eq(governanceRules.groupId, groupId))).map((r) => [r.action, r.thresholdPermille]),
    );
    expect(rules).toMatchObject({
      FUND_RELEASE_SMALL: 600,
      FUND_RELEASE_LARGE: 700,
      REMOVE_MEMBER: 800,
      CHANGE_CONTRIBUTION: 900,
      CHANGE_GOVERNANCE: 850,
      DISSOLVE_GROUP: 950,
    });
  });
});

describe("a new payout order, once voted", () => {
  it("hands the same seats out again in the voted order", async () => {
    const [ade] = await t.db.insert(users).values({ displayName: "Ade", walletAddress: "0x00000000000000000000000000000000000000a1" }).returning();
    const [bisi] = await t.db.insert(users).values({ displayName: "Bisi", walletAddress: "0x00000000000000000000000000000000000000b2" }).returning();
    const [chidi] = await t.db.insert(users).values({ displayName: "Chidi", walletAddress: "0x00000000000000000000000000000000000000c3" }).returning();
    const { groupId } = await createGroup(ade.id, {
      name: "Ajo",
      type: "ROTATING",
      contributionAmount: Money.fromMajor(100, "USDC"),
      cadence: "MONTHLY",
      dueDay: 1,
    });
    await t.db.insert(groupMembers).values([
      { groupId, userId: bisi.id, role: "MEMBER", status: "ACTIVE", rotationPosition: 2 },
      { groupId, userId: chidi.id, role: "MEMBER", status: "ACTIVE", rotationPosition: 3 },
    ]);

    // Ade has collected (seat 1); Bisi and Chidi swap seats 2 and 3.
    const payload = encodeAbiParameters([{ type: "address[]" }], [["0x00000000000000000000000000000000000000c3", "0x00000000000000000000000000000000000000b2"]]);
    await t.db.transaction((tx) => applyOnRallied(tx, groupId, "CHANGE_ORDER", payload));

    const seats = await t.db.select({ userId: groupMembers.userId, seat: groupMembers.rotationPosition }).from(groupMembers).where(eq(groupMembers.groupId, groupId));
    const seatOf = (userId: string) => seats.find((s) => s.userId === userId)?.seat;
    expect([seatOf(ade.id), seatOf(chidi.id), seatOf(bisi.id)]).toEqual([1, 2, 3]);
  });
});
