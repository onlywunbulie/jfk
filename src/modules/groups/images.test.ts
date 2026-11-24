import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => ({ fetched: [] as string[], removed: [] as (string | null)[], stored: 0 }));
vi.mock("@/lib/fetch-image", () => ({
  fetchPublicImage: async (link: string) => {
    calls.fetched.push(link);
    return { ok: true, bytes: Buffer.from("image"), type: "image/png" };
  },
}));
vi.mock("@/lib/process-image", () => ({ toStoredWebp: async () => ({ ok: true, bytes: new Uint8Array([1]) }) }));
vi.mock("@/lib/blob", () => ({
  storeGroupImage: async () => ({ ok: true, url: `https://x.public.blob.vercel-storage.com/pic-${++calls.stored}.webp` }),
  removeStoredImage: async (url: string | null) => {
    calls.removed.push(url);
  },
}));

const { setGroupImageFromLink } = await import("@/modules/groups/images");
const { createGroup, listGroupsForUser } = await import("@/modules/groups/service");
const { users, groupMembers } = await import("@/lib/db/schema");
const { Money } = await import("@/lib/money");

beforeEach(async () => {
  await t.reset();
  Object.assign(calls, { fetched: [], removed: [], stored: 0 });
});
afterAll(async () => {
  await t.close();
});

async function groupWithMember() {
  const [owner] = await t.db.insert(users).values({ displayName: "Ade" }).returning();
  const [member] = await t.db.insert(users).values({ displayName: "Bisi" }).returning();
  const { groupId } = await createGroup(owner.id, {
    name: "Ajo",
    type: "ROTATING",
    contributionAmount: Money.fromMajor(100, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  await t.db.insert(groupMembers).values({ groupId, userId: member.id, role: "MEMBER", status: "ACTIVE" });
  return { owner: owner.id, member: member.id, groupId };
}

describe("setting a group image from a link", () => {
  it("refuses a plain member before fetching anything", async () => {
    const { member, groupId } = await groupWithMember();
    expect(await setGroupImageFromLink(member, groupId, "avatar", "https://example.com/a.png")).toMatchObject({ ok: false });
    expect(calls.fetched).toEqual([]);
  });

  it("lets the owner set it, and removes the image it replaces", async () => {
    const { owner, groupId } = await groupWithMember();
    expect(await setGroupImageFromLink(owner, groupId, "banner", "https://example.com/one.png")).toEqual({ ok: true });
    expect(await setGroupImageFromLink(owner, groupId, "banner", "https://example.com/two.png")).toEqual({ ok: true });
    const [group] = await listGroupsForUser(owner);
    expect(group.bannerUrl).toBe("https://x.public.blob.vercel-storage.com/pic-2.webp");
    expect(calls.removed).toEqual([null, "https://x.public.blob.vercel-storage.com/pic-1.webp"]);
  });
});
