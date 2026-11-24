import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: () => ({ SESSION_SECRET: "a-test-secret-that-is-long-enough-123" }) }));

const saved = vi.hoisted(() => ({ calls: [] as { userId: string; groupId: string; kind: string; size: number }[] }));
vi.mock("@/modules/groups/images", () => ({
  setGroupImageFromBytes: async (userId: string, groupId: string, kind: string, bytes: Buffer) => {
    saved.calls.push({ userId, groupId, kind, size: bytes.length });
    return { ok: true };
  },
}));

const { PUT } = await import("@/app/api/upload/group-image/[token]/route");
const { issueUploadToken } = await import("@/lib/upload-token");

beforeEach(async () => {
  await t.reset();
  saved.calls = [];
});
afterAll(async () => {
  await t.close();
});

const send = (token: string, body: BodyInit) =>
  PUT(new Request(`https://getrallied.test/api/upload/group-image/${token}`, { method: "PUT", body }), { params: Promise.resolve({ token }) });

describe("uploading a group image to a one-time address", () => {
  it("saves the image for the group and image the address names", async () => {
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "banner" });
    const response = await send(token, new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, set: "banner" });
    expect(saved.calls).toEqual([{ userId: "u1", groupId: "g1", kind: "banner", size: 3 }]);
  });

  it("works once", async () => {
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "avatar" });
    expect((await send(token, new Uint8Array([1]))).status).toBe(200);
    expect((await send(token, new Uint8Array([1]))).status).toBe(409);
    expect(saved.calls).toHaveLength(1);
  });

  it("refuses an address that isn't Rallied's, and an empty upload", async () => {
    expect((await send("made.up", new Uint8Array([1]))).status).toBe(401);
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "avatar" });
    expect((await send(token, new Uint8Array([]))).status).toBe(400);
    expect(saved.calls).toEqual([]);
  });
});
