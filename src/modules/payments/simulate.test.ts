import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const { simulateContribution, simulationAvailable } = await import("./simulate");
const ledger = await import("@/modules/ledger/service");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const { users, groups, groupSettings, payments, webhookEvents } = await import(
  "@/lib/db/schema"
);

const GROUP = "019ff200-0000-7000-8000-00000000aaaa";
const USER = "019ff200-0000-7000-8000-00000000bbbb";

const environment = process.env as Record<string, string | undefined>;

beforeEach(async () => {
  await t.reset();
  await t.db
    .insert(users)
    .values({ id: USER, email: "geoffrey@jfk.test", displayName: "Geoffrey" });
  await t.db.insert(groups).values({ id: GROUP, name: "JFK Empire", ownerId: USER });
  await t.db.insert(groupSettings).values({
    groupId: GROUP,
    contributionAmount: Money.fromMajor(50_000).minor,
  });
});

afterEach(() => {
  environment.NODE_ENV = "test";
  environment.PAYSTACK_SECRET_KEY = "";
  vi.resetModules();
});

afterAll(async () => {
  await t.close();
});

describe("safety gates", () => {
  it("is available in development", () => {
    expect(simulationAvailable()).toBe(true);
  });

  it("refuses to run in production", async () => {
    environment.NODE_ENV = "production";
    // env() caches, so re-import to pick up the changed environment.
    vi.resetModules();
    const fresh = await import("./simulate");

    expect(fresh.simulationAvailable()).toBe(false);
    await expect(
      fresh.simulateContribution({ groupId: GROUP, userId: USER }),
    ).rejects.toThrow(/production/);
  });

  it("refuses when a live Paystack key is configured", async () => {
    environment.PAYSTACK_SECRET_KEY = "sk_live_a_real_key";
    vi.resetModules();
    const fresh = await import("./simulate");

    expect(fresh.simulationAvailable()).toBe(false);
    await expect(
      fresh.simulateContribution({ groupId: GROUP, userId: USER }),
    ).rejects.toThrow(/live Paystack key/);
  });

  it("stays available with a test key", async () => {
    environment.PAYSTACK_SECRET_KEY = "sk_test_harmless";
    vi.resetModules();
    const fresh = await import("./simulate");
    expect(fresh.simulationAvailable()).toBe(true);
  });
});

describe("a simulated contribution", () => {
  it("runs the real pipeline and credits the treasury", async () => {
    const result = await simulateContribution({ groupId: GROUP, userId: USER });

    expect(result.outcome).toBe("processed");
    // Gross-up: the card carries the fee, the treasury gets the round figure.
    expect(result.charged.format()).toBe("₦50,862.94");
    expect(result.net.format()).toBe("₦50,000.00");

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });

  it("goes through signature verification rather than around it", async () => {
    await simulateContribution({ groupId: GROUP, userId: USER });

    // A webhook row exists and is marked as having a valid signature, which
    // only happens if the real verifier accepted it.
    const [event] = await t.db.select().from(webhookEvents);
    expect(event.signatureValid).toBe(true);
    expect(event.processedAt).not.toBeNull();
  });

  it("leaves a settled payment row linked to the ledger", async () => {
    await simulateContribution({ groupId: GROUP, userId: USER });

    const [payment] = await t.db.select().from(payments);
    expect(payment.status).toBe("SUCCESS");
    expect(payment.ledgerTransactionId).not.toBeNull();
    expect(payment.fee).toBe(86_294n);
  });

  it("saves the card so later runs look like a returning member", async () => {
    await simulateContribution({ groupId: GROUP, userId: USER });
    const methods = await (
      await import("./service")
    ).listPaymentMethods(USER);

    expect(methods).toHaveLength(1);
    expect(methods[0].last4).toBe("4321");
  });

  it("accumulates across several runs without duplicating anything", async () => {
    for (let i = 0; i < 3; i++) {
      await simulateContribution({ groupId: GROUP, userId: USER });
    }

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦150,000.00");
    expect(await t.db.select().from(webhookEvents)).toHaveLength(3);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });

  it("honours an explicit amount", async () => {
    const result = await simulateContribution({
      groupId: GROUP,
      userId: USER,
      amount: Money.fromMajor(200_000),
    });

    expect(result.net.format()).toBe("₦200,000.00");
    // Fee is capped at ₦2,000 up here.
    expect(result.fee.format()).toBe("₦2,000.00");
  });
});

describe("a simulated decline", () => {
  it("marks the payment failed and leaves the books untouched", async () => {
    const result = await simulateContribution({
      groupId: GROUP,
      userId: USER,
      fail: true,
    });

    expect(result.outcome).toBe("processed");

    const [payment] = await t.db.select().from(payments);
    expect(payment.status).toBe("FAILED");
    expect(payment.failureReason).toBe("Insufficient funds");

    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });
});
