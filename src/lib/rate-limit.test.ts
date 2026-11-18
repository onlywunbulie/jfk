import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";

// The limiter against a real Postgres: counts, refuses past the limit,
// restarts after the window, and holds under a burst of parallel requests.
const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
vi.mock("server-only", () => ({}));

const { rateLimit } = await import("@/lib/rate-limit");

beforeEach(async () => {
  await t.reset();
  vi.useRealTimers();
});
afterAll(async () => {
  await t.close();
});

describe("rate limits", () => {
  it("lets the first N through, refuses the next with when to retry, and keeps keys apart", async () => {
    for (let i = 0; i < 3; i++) expect(await rateLimit("sign-in:ip:1.2.3.4", 3, 60)).toEqual({ ok: true });
    const refused = await rateLimit("sign-in:ip:1.2.3.4", 3, 60);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(await rateLimit("sign-in:ip:5.6.7.8", 3, 60)).toEqual({ ok: true });
  });

  it("starts counting again once the window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    for (let i = 0; i < 2; i++) await rateLimit("k", 2, 60);
    expect((await rateLimit("k", 2, 60)).ok).toBe(false);
    vi.setSystemTime(new Date("2026-11-18T10:01:01Z"));
    expect(await rateLimit("k", 2, 60)).toEqual({ ok: true });
  });

  it("a burst of parallel requests can't slip past the count", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit("burst", 5, 60)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });
});
