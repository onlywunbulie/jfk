import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/lib/db/testing";
import { Money } from "@/lib/money";
import { PaystackProvider } from "./paystack";

const t: TestDb = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));

const service = await import("./service");
const ledger = await import("@/modules/ledger/service");
const { reconcileLedger } = await import("@/modules/ledger/reconcile");
const {
  users,
  groups,
  groupSettings,
  payments,
  paymentMethods,
  webhookEvents,
} = await import("@/lib/db/schema");

const SECRET = "sk_test_pretend_secret_key";
const provider = new PaystackProvider(SECRET);

const GROUP = "019ff100-0000-7000-8000-00000000aaaa";
const USER = "019ff100-0000-7000-8000-00000000bbbb";

function deliver(body: object, secret = SECRET) {
  const raw = JSON.stringify(body);
  const headers = new Headers({
    "x-paystack-signature": createHmac("sha512", secret)
      .update(raw, "utf8")
      .digest("hex"),
  });
  return service.handleWebhook(provider, raw, headers);
}

function chargeSuccessBody(overrides: {
  reference: string;
  amount: number;
  fees: number;
  withCard?: boolean;
}) {
  return {
    event: "charge.success",
    data: {
      id: 302961,
      reference: overrides.reference,
      amount: overrides.amount,
      fees: overrides.fees,
      status: "success",
      gateway_response: "Successful",
      ...(overrides.withCard === false
        ? {}
        : {
            authorization: {
              authorization_code: "AUTH_pmx3mgawyd",
              signature: "SIG_2Gvc6pNuzJmj4TCchXfp",
              last4: "4321",
              brand: "visa",
              bank: "GTBank",
              exp_month: "09",
              exp_year: "2028",
              reusable: true,
            },
          }),
    },
  };
}

async function seed() {
  await t.db
    .insert(users)
    .values({ id: USER, email: "geoffrey@jfk.test", displayName: "Geoffrey" });
  await t.db
    .insert(groups)
    .values({ id: GROUP, name: "JFK Empire", ownerId: USER });
  await t.db.insert(groupSettings).values({ groupId: GROUP });
}

/** Register the intent to charge, as the contribution flow would. */
async function startContribution(reference: string, amount: Money) {
  return service.startPayment({
    reference,
    purpose: "CONTRIBUTION",
    amount,
    userId: USER,
    groupId: GROUP,
  });
}

beforeEach(async () => {
  await t.reset();
  await seed();
});

afterAll(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe("startPayment", () => {
  it("records intent before the provider is called", async () => {
    const { alreadyExists } = await startContribution(
      "jfk_c_1",
      Money.fromMajor(50_000),
    );
    expect(alreadyExists).toBe(false);

    const [row] = await t.db.select().from(payments);
    expect(row.status).toBe("INITIATED");
    expect(row.settledAt).toBeNull();
    // Nothing has hit the books yet.
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);
  });

  it("is idempotent on reference, so a retry cannot create a second payment", async () => {
    const first = await startContribution("jfk_c_1", Money.fromMajor(50_000));
    const second = await startContribution("jfk_c_1", Money.fromMajor(50_000));

    expect(second.alreadyExists).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(await t.db.select().from(payments)).toHaveLength(1);
  });
});

describe("webhook signature", () => {
  it("refuses an unsigned or wrongly signed delivery and stores nothing", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));

    const body = chargeSuccessBody({
      reference: "jfk_c_1",
      amount: 5_086_294,
      fees: 86_294,
    });

    const forged = await deliver(body, "sk_test_attacker");
    expect(forged).toEqual({ outcome: "invalid_signature" });

    const unsigned = await service.handleWebhook(
      provider,
      JSON.stringify(body),
      new Headers(),
    );
    expect(unsigned).toEqual({ outcome: "invalid_signature" });

    // An attacker must not be able to write rows or move money.
    expect(await t.db.select().from(webhookEvents)).toHaveLength(0);
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);
  });
});

describe("duplicate webhooks — the guarantee that matters", () => {
  it("credits the group exactly once when the same event arrives three times", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));

    const body = chargeSuccessBody({
      reference: "jfk_c_1",
      amount: 5_086_294,
      fees: 86_294,
    });

    const first = await deliver(body);
    const second = await deliver(body);
    const third = await deliver(body);

    expect(first.outcome).toBe("processed");
    expect(second.outcome).toBe("duplicate");
    expect(third.outcome).toBe("duplicate");

    // Exactly one contribution, one ledger transaction, one webhook row.
    expect(await t.db.select().from(webhookEvents)).toHaveLength(1);

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");

    const entries = await ledger.listEntries(ledger.groupAvailable(GROUP));
    expect(entries).toHaveLength(1);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });

  it("stays correct even if the payment row is somehow settled twice", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    const body = chargeSuccessBody({
      reference: "jfk_c_1",
      amount: 5_086_294,
      fees: 86_294,
    });

    await deliver(body);

    // Force a second application by clearing the dedupe row — simulating a
    // bug or a manual replay. The ledger's own idempotency key must still hold.
    await t.sql(`delete from webhook_events`);
    const replay = await deliver(body);

    expect(replay.outcome).toBe("duplicate");
    expect((await ledger.getGroupBalances(GROUP)).available.format()).toBe(
      "₦50,000.00",
    );
  });
});

describe("settling a contribution", () => {
  it("posts to the ledger using Paystack's figures, not our estimate", async () => {
    // We guessed ₦50,000; Paystack actually took ₦862.94 from ₦50,862.94.
    await startContribution("jfk_c_1", Money.fromMajor(50_000));

    await deliver(
      chargeSuccessBody({
        reference: "jfk_c_1",
        amount: 5_086_294,
        fees: 86_294,
      }),
    );

    const [payment] = await t.db.select().from(payments);
    expect(payment.status).toBe("SUCCESS");
    expect(payment.amount).toBe(5_086_294n);
    expect(payment.fee).toBe(86_294n);
    expect(payment.ledgerTransactionId).not.toBeNull();
    expect(payment.settledAt).not.toBeNull();

    // The treasury gets exactly the round contribution: gross-up working.
    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦50,000.00");

    const feeExpense = await ledger.getBalance(
      ledger.systemAccount("FEE_EXPENSE"),
    );
    expect(feeExpense.format()).toBe("₦862.94");
  });

  it("settles payment and ledger atomically", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    await deliver(
      chargeSuccessBody({ reference: "jfk_c_1", amount: 5_086_294, fees: 86_294 }),
    );

    const [payment] = await t.db.select().from(payments);
    const entries = await ledger.listEntries(ledger.groupAvailable(GROUP));

    // A settled payment must never exist without its ledger entry.
    expect(payment.status).toBe("SUCCESS");
    expect(entries).toHaveLength(1);
    expect(entries[0].amount.format()).toBe("₦50,000.00");
  });

  it("ignores money for a reference we never issued", async () => {
    const result = await deliver(
      chargeSuccessBody({ reference: "not_ours", amount: 100_000, fees: 0 }),
    );

    expect(result.outcome).toBe("ignored");
    // Recorded for investigation, but never guessed at.
    expect(await t.db.select().from(webhookEvents)).toHaveLength(1);
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);
  });

  it("marks a failed charge without touching the books", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));

    const result = await deliver({
      event: "charge.failed",
      data: {
        reference: "jfk_c_1",
        amount: 5_086_294,
        status: "failed",
        gateway_response: "Insufficient funds",
      },
    });

    expect(result.outcome).toBe("processed");

    const [payment] = await t.db.select().from(payments);
    expect(payment.status).toBe("FAILED");
    expect(payment.failureReason).toBe("Insufficient funds");
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);
  });
});

describe("card tokenization", () => {
  it("saves the reusable token and never a card number", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    await deliver(
      chargeSuccessBody({ reference: "jfk_c_1", amount: 5_086_294, fees: 86_294 }),
    );

    const [method] = await t.db.select().from(paymentMethods);
    expect(method.providerAuthCode).toBe("AUTH_pmx3mgawyd");
    expect(method.last4).toBe("4321");
    expect(method.brand).toBe("visa");
    expect(method.isDefault).toBe(true);

    // Nothing resembling a PAN anywhere on the row.
    const serialised = JSON.stringify(method);
    expect(serialised).not.toMatch(/\d{13,19}/);
  });

  it("does not duplicate a card the member has already added", async () => {
    for (const [index, reference] of ["jfk_c_1", "jfk_c_2"].entries()) {
      await startContribution(reference, Money.fromMajor(50_000));
      await deliver(
        chargeSuccessBody({
          reference,
          amount: 5_086_294 + index,
          fees: 86_294,
        }),
      );
    }

    // Same card signature both times, so one entry.
    expect(await t.db.select().from(paymentMethods)).toHaveLength(1);
  });

  it("makes only the first card the default", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    await deliver(
      chargeSuccessBody({ reference: "jfk_c_1", amount: 5_086_294, fees: 86_294 }),
    );

    await startContribution("jfk_c_2", Money.fromMajor(50_000));
    const secondCard = chargeSuccessBody({
      reference: "jfk_c_2",
      amount: 5_086_294,
      fees: 86_294,
    });
    secondCard.data.authorization!.signature = "SIG_different_card";
    secondCard.data.authorization!.authorization_code = "AUTH_second";
    secondCard.data.authorization!.last4 = "9876";
    await deliver(secondCard);

    const methods = await service.listPaymentMethods(USER);
    expect(methods).toHaveLength(2);
    expect(methods.filter((m) => m.isDefault)).toHaveLength(1);
    expect(methods.find((m) => m.isDefault)!.last4).toBe("4321");
  });

  it("does not post a tokenization charge to any group's books", async () => {
    await service.startPayment({
      reference: "jfk_tok_1",
      purpose: "CARD_TOKENIZATION",
      amount: Money.fromMajor(50),
      userId: USER,
    });

    await deliver(
      chargeSuccessBody({ reference: "jfk_tok_1", amount: 5_000, fees: 75 }),
    );

    // The card is saved but no money enters a treasury.
    expect(await t.db.select().from(paymentMethods)).toHaveLength(1);
    expect((await ledger.getGroupBalances(GROUP)).total.isZero()).toBe(true);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
  });
});

describe("expiring cards", () => {
  it("flags a card within 60 days of expiry", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    await deliver(
      chargeSuccessBody({ reference: "jfk_c_1", amount: 5_086_294, fees: 86_294 }),
    );

    const soon = new Date();
    soon.setMonth(soon.getMonth() + 1);
    await t.db.update(paymentMethods).set({
      expMonth: soon.getMonth() + 1,
      expYear: soon.getFullYear(),
    });

    const [method] = await service.listPaymentMethods(USER);
    expect(method.expiringSoon).toBe(true);
  });

  it("leaves a card years from expiry alone", async () => {
    await startContribution("jfk_c_1", Money.fromMajor(50_000));
    await deliver(
      chargeSuccessBody({ reference: "jfk_c_1", amount: 5_086_294, fees: 86_294 }),
    );

    const [method] = await service.listPaymentMethods(USER);
    expect(method.expiringSoon).toBe(false);
  });
});

describe("a full contribution cycle", () => {
  it("collects from four members and reconciles clean", async () => {
    const members = ["chuka", "tunde", "amaka", "bola"];

    for (const [index, name] of members.entries()) {
      const [member] = await t.db
        .insert(users)
        .values({ email: `${name}@jfk.test`, displayName: name })
        .returning({ id: users.id });

      const reference = `jfk_c_cycle1_${index}`;
      await service.startPayment({
        reference,
        purpose: "CONTRIBUTION",
        amount: Money.fromMajor(50_000),
        userId: member.id,
        groupId: GROUP,
      });

      const body = chargeSuccessBody({
        reference,
        amount: 5_086_294,
        fees: 86_294,
      });
      body.data.authorization!.signature = `SIG_${name}`;
      body.data.authorization!.authorization_code = `AUTH_${name}`;
      await deliver(body);
    }

    const balances = await ledger.getGroupBalances(GROUP);
    expect(balances.available.format()).toBe("₦200,000.00");

    const settled = await t.db
      .select()
      .from(payments)
      .where(eq(payments.status, "SUCCESS"));
    expect(settled).toHaveLength(4);

    const report = await reconcileLedger(t.db);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
