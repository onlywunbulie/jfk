import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { initialSignInState } from "./state";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

/** In-memory cookie jar standing in for the browser's. */
const jar = new Map<string, { value: string; options: unknown }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)!.value } : undefined,
    set: (name: string, value: string, options: unknown) =>
      jar.set(name, { value, options }),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () =>
    new Headers({ "x-forwarded-for": "102.89.1.1", "user-agent": "vitest" }),
}));

// `redirect()` throws to unwind the render; mirror that so the action's
// control flow is exercised exactly as it is in production.
class RedirectError extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

const { requestCodeAction, verifyCodeAction } = await import("./actions");
const { getCurrentUser } = await import("@/lib/auth/session");
const { users, sessions, loginCodes } = await import("@/lib/db/schema");

beforeEach(async () => {
  jar.clear();
  await t.db.delete(sessions);
  await t.db.delete(loginCodes);
  await t.db.delete(users);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterAll(async () => {
  await t.close();
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.append(k, v);
  return data;
}

describe("requestCodeAction", () => {
  it("advances to the code step for a valid email", async () => {
    const state = await requestCodeAction(
      initialSignInState,
      form({ email: "geoffrey@jfk.test" }),
    );

    expect(state.step).toBe("code");
    expect(state.email).toBe("geoffrey@jfk.test");
    expect(state.error).toBeNull();
    expect(state.devCode).toMatch(/^\d{6}$/);
  });

  it("stays on the email step and explains a malformed address", async () => {
    const state = await requestCodeAction(
      initialSignInState,
      form({ email: "not-an-email" }),
    );

    expect(state.step).toBe("email");
    expect(state.error).toMatch(/email address/i);
    expect(await t.db.select().from(loginCodes)).toHaveLength(0);
  });

  it("surfaces the rate limit with a wait time", async () => {
    for (let i = 0; i < 5; i++) {
      await requestCodeAction(initialSignInState, form({ email: "s@jfk.test" }));
    }

    const state = await requestCodeAction(
      initialSignInState,
      form({ email: "s@jfk.test" }),
    );
    expect(state.step).toBe("email");
    expect(state.error).toMatch(/Too many codes requested.*minute/);
  });
});

describe("verifyCodeAction", () => {
  async function reachCodeStep(email = "geoffrey@jfk.test") {
    const state = await requestCodeAction(initialSignInState, form({ email }));
    return { state, code: state.devCode! };
  }

  it("signs the user in and sets an httpOnly session cookie", async () => {
    const { state, code } = await reachCodeStep();

    const redirected = await verifyCodeAction(state, form({ code })).catch(
      (e) => e,
    );

    expect(redirected).toBeInstanceOf(RedirectError);
    expect((redirected as RedirectError).to).toBe("/");

    const cookie = jar.get("jfk_session");
    expect(cookie).toBeDefined();
    expect(cookie!.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });

    // And the session actually resolves back to the right user.
    const user = await getCurrentUser();
    expect(user?.email).toBe("geoffrey@jfk.test");
    expect(user?.hasPin).toBe(false);
  });

  it("records the session against the user with an expiry", async () => {
    const { state, code } = await reachCodeStep();
    await verifyCodeAction(state, form({ code })).catch(() => {});

    const [session] = await t.db.select().from(sessions);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(session.userAgent).toBe("vitest");
    // The raw token lives only in the cookie.
    expect(session.tokenHash).not.toBe(jar.get("jfk_session")!.value);
  });

  it("rejects a wrong code without signing anyone in", async () => {
    const { state } = await reachCodeStep();

    const next = await verifyCodeAction(state, form({ code: "000000" }));

    expect(next.step).toBe("code");
    expect(next.error).toMatch(/isn't right/);
    expect(jar.has("jfk_session")).toBe(false);
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejects a malformed code before touching the database", async () => {
    const { state } = await reachCodeStep();

    const next = await verifyCodeAction(state, form({ code: "12" }));
    expect(next.error).toMatch(/6-digit/);

    const [row] = await t.db.select().from(loginCodes);
    expect(row.attempts).toBe(0);
  });

  it("sends the user back to the email step once the code expires", async () => {
    const { state, code } = await reachCodeStep();
    await t.db
      .update(loginCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) });

    const next = await verifyCodeAction(state, form({ code }));
    expect(next.step).toBe("email");
    expect(next.error).toMatch(/expired/);
    expect(jar.has("jfk_session")).toBe(false);
  });

  it("does not let a used code create a second session", async () => {
    const { state, code } = await reachCodeStep();
    await verifyCodeAction(state, form({ code })).catch(() => {});
    jar.clear();

    const replay = await verifyCodeAction(state, form({ code }));
    expect(replay.error).toBeTruthy();
    expect(jar.has("jfk_session")).toBe(false);
    expect(await t.db.select().from(sessions)).toHaveLength(1);
  });
});
