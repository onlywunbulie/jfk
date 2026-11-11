import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const chat = await import("./service");
const { loadFeed } = await import("./feed");
const groupsService = await import("@/modules/groups/service");
const governance = await import("@/modules/governance/service");
const { simulateContribution } = await import("@/modules/payments/simulate");
const { users } = await import("@/lib/db/schema");

async function person(name: string) {
  const [row] = await t.db
    .insert(users)
    .values({ email: `${name}@jfk.test`, displayName: name })
    .returning({ id: users.id });
  return row.id;
}

async function groupOf(...names: string[]) {
  const ids = [];
  for (const name of names) ids.push(await person(name));
  const { groupId } = await groupsService.createGroup(ids[0], {
    name: "Brothers",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(50_000),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  const invite = await groupsService.createInvite(groupId, ids[0], { maxUses: 10 });
  if (!invite.ok) throw new Error("invite failed");
  for (const id of ids.slice(1)) await groupsService.acceptInvite(invite.code, id);
  return { groupId, ids };
}

beforeEach(async () => {
  await t.reset();
});

afterAll(async () => {
  await t.close();
});

describe("talking in a group", () => {
  it("lets members post and read, oldest first", async () => {
    const { groupId, ids } = await groupOf("Amaka", "Tunde");
    await chat.postMessage(groupId, ids[0], "who's paying for the generator?");
    await chat.postMessage(groupId, ids[1], "  me  ");

    const texts = (await chat.listMessages(groupId, ids[1]))?.filter((m) => m.kind === "TEXT");
    expect(texts?.map((m) => [m.authorName, m.body])).toEqual([
      ["Amaka", "who's paying for the generator?"],
      ["Tunde", "me"],
    ]);
  });

  it("keeps outsiders out, both reading and writing", async () => {
    const { groupId } = await groupOf("Amaka");
    const stranger = await person("Stranger");

    expect(await chat.listMessages(groupId, stranger)).toBeNull();
    expect(await chat.postMessage(groupId, stranger, "hello")).toEqual({ ok: false, reason: "not_member" });
  });

  it("refuses empty and overlong messages", async () => {
    const { groupId, ids } = await groupOf("Amaka");
    expect(await chat.postMessage(groupId, ids[0], "   ")).toEqual({ ok: false, reason: "empty" });
    expect(await chat.postMessage(groupId, ids[0], "x".repeat(chat.MAX_MESSAGE_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });
});

describe("what the group sees happen", () => {
  it("shows people joining", async () => {
    const { groupId, ids } = await groupOf("Amaka", "Tunde");
    const feed = await loadFeed(groupId, ids[0]);
    expect(feed?.find((item) => item.kind === "joined")).toMatchObject({ name: "Tunde" });
  });

  it("shows a proposal as a live card, then its result", async () => {
    const { groupId, ids } = await groupOf("Amaka", "Tunde", "Kemi");
    for (const id of ids) await simulateContribution({ groupId, userId: id });

    const opened = await governance.createProposal(ids[0], {
      groupId,
      title: "Generator for mum's shop",
      reason: "The shop keeps losing power",
      amount: Money.fromMajor(20_000),
      destination: "Supplier",
    });
    if (!opened.ok) throw new Error("proposal failed");

    let feed = await loadFeed(groupId, ids[1]);
    const card = feed?.find((item) => item.kind === "proposal");
    expect(card).toMatchObject({
      proposal: { title: "Generator for mum's shop", proposer: "Amaka", yes: 0, eligible: 3, canVote: true },
    });

    // The card reads the live tally, so a vote shows up on the same card.
    await governance.castVote(opened.proposalId, ids[1], "YES");
    feed = await loadFeed(groupId, ids[1]);
    expect(feed?.find((item) => item.kind === "proposal")).toMatchObject({
      proposal: { yes: 1, yourVote: "YES" },
    });

    // Enough yes votes settle it, and the chat says so.
    await governance.castVote(opened.proposalId, ids[2], "YES");
    feed = await loadFeed(groupId, ids[0]);
    expect(feed?.find((item) => item.kind === "decided")).toMatchObject({
      title: "Generator for mum's shop",
      outcome: "approved",
    });
  });
});
