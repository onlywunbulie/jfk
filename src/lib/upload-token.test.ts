import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: () => ({ SESSION_SECRET: "a-test-secret-that-is-long-enough-123" }) }));
const { issueUploadToken, readUploadToken } = await import("@/lib/upload-token");

const NOW = new Date("2026-11-25T10:00:00Z");

describe("one-time upload addresses", () => {
  it("reads back who, which group and which image", () => {
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "banner" }, NOW);
    expect(readUploadToken(token, NOW)).toMatchObject({ userId: "u1", groupId: "g1", kind: "banner" });
  });

  it("refuses a token that was changed: another group, or another image", () => {
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "avatar" }, NOW);
    const [body, signature] = token.split(".");
    const grant = JSON.parse(Buffer.from(body, "base64url").toString());
    const changed = Buffer.from(JSON.stringify({ ...grant, groupId: "someone-elses-group" })).toString("base64url");
    expect(readUploadToken(`${changed}.${signature}`, NOW)).toBeNull();
    expect(readUploadToken(`${body}.${signature.slice(0, -2)}xx`, NOW)).toBeNull();
    expect(readUploadToken("not-a-token", NOW)).toBeNull();
  });

  it("stops working after 15 minutes", () => {
    const token = issueUploadToken({ userId: "u1", groupId: "g1", kind: "avatar" }, NOW);
    expect(readUploadToken(token, new Date(NOW.getTime() + 14 * 60_000))).not.toBeNull();
    expect(readUploadToken(token, new Date(NOW.getTime() + 16 * 60_000))).toBeNull();
  });
});
