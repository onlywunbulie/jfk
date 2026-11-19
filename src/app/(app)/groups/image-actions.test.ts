import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

// Who is signed in, swapped per test.
let signedIn = "";
vi.mock("@/lib/auth/session", () => ({ requireUser: async () => ({ id: signedIn }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Blob, faked: records what was stored and removed.
const stored: string[] = [];
const removed: (string | null)[] = [];
vi.mock("@/lib/blob", () => ({
  storeGroupImage: async (groupId: string, kind: string) => {
    const url = `https://x.public.blob.vercel-storage.com/groups/${groupId}/${kind}-${stored.length}.webp`;
    stored.push(url);
    return { ok: true, url };
  },
  removeStoredImage: async (url: string | null) => {
    removed.push(url);
  },
}));

const { uploadGroupImageAction, removeGroupImageAction } = await import("@/app/(app)/groups/image-actions");
const service = await import("@/modules/groups/service");
const { users } = await import("@/lib/db/schema");

async function makeUser(name: string): Promise<string> {
  const [user] = await t.db.insert(users).values({ email: `${name}@jfk.test`, displayName: name }).returning({ id: users.id });
  return user.id;
}

const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
const formWith = (bytes: Uint8Array) => {
  const form = new FormData();
  form.set("image", new Blob([bytes as BlobPart], { type: "image/webp" }), "avatar.webp");
  return form;
};

async function groupWithMember() {
  const owner = await makeUser("owner");
  const { groupId } = await service.createGroup(owner, {
    name: "Detty December",
    type: "TREASURY",
    contributionAmount: Money.fromMajor(50, "USDC"),
    cadence: "MONTHLY",
    dueDay: 1,
  });
  const invite = await service.createInvite(groupId, owner);
  if (!invite.ok) throw new Error("setup failed");
  const member = await makeUser("member");
  await service.acceptInvite(invite.code, member);
  return { owner, member, groupId };
}

beforeEach(async () => {
  await t.reset();
  stored.length = 0;
  removed.length = 0;
});
afterAll(async () => {
  await t.close();
});

describe("uploadGroupImageAction", () => {
  it("stores the owner's picture, and removes the one it replaces", async () => {
    const { owner, groupId } = await groupWithMember();
    signedIn = owner;

    expect(await uploadGroupImageAction(groupId, "avatar", formWith(WEBP))).toEqual({ ok: true });
    expect(await uploadGroupImageAction(groupId, "avatar", formWith(WEBP))).toEqual({ ok: true });

    const [summary] = await service.listGroupsForUser(owner);
    expect(summary.avatarUrl).toBe(stored[1]);
    expect(removed).toEqual([null, stored[0]]);
  });

  it("refuses a plain member before storing anything", async () => {
    const { member, groupId } = await groupWithMember();
    signedIn = member;

    const result = await uploadGroupImageAction(groupId, "banner", formWith(WEBP));
    expect(result).toMatchObject({ ok: false });
    expect(stored).toEqual([]);
  });

  it("refuses anything that isn't really a WebP, and unknown kinds", async () => {
    const { owner, groupId } = await groupWithMember();
    signedIn = owner;

    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect(await uploadGroupImageAction(groupId, "avatar", formWith(svg))).toMatchObject({ ok: false });
    expect(await uploadGroupImageAction(groupId, "background", formWith(WEBP))).toMatchObject({ ok: false });
    expect(stored).toEqual([]);
  });
});

describe("removeGroupImageAction", () => {
  it("puts the first letter back and removes the file", async () => {
    const { owner, groupId } = await groupWithMember();
    signedIn = owner;
    await uploadGroupImageAction(groupId, "avatar", formWith(WEBP));

    expect(await removeGroupImageAction(groupId, "avatar")).toEqual({ ok: true });
    const [summary] = await service.listGroupsForUser(owner);
    expect(summary.avatarUrl).toBeNull();
    expect(removed.at(-1)).toBe(stored[0]);
  });
});
