import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaystackProvider } from "./paystack";
import { Money } from "@/lib/money";

const SECRET = "sk_test_pretend_secret_key";
const provider = new PaystackProvider(SECRET);

function sign(body: string, secret = SECRET): Headers {
  return new Headers({
    "x-paystack-signature": createHmac("sha512", secret)
      .update(body, "utf8")
      .digest("hex"),
  });
}

const chargeSuccess = {
  event: "charge.success",
  data: {
    id: 302961,
    reference: "jfk_c_abc123",
    amount: 5_086_294,
    fees: 86_294,
    status: "success",
    gateway_response: "Successful",
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
  },
};

describe("verifyWebhook", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify(chargeSuccess);
    const result = provider.verifyWebhook(body, sign(body));
    expect(result.valid).toBe(true);
  });

  it("rejects a body signed with the wrong key", () => {
    const body = JSON.stringify(chargeSuccess);
    const result = provider.verifyWebhook(body, sign(body, "sk_test_attacker"));
    expect(result).toEqual({ valid: false, reason: "signature mismatch" });
  });

  it("rejects a missing signature header", () => {
    const body = JSON.stringify(chargeSuccess);
    const result = provider.verifyWebhook(body, new Headers());
    expect(result).toEqual({ valid: false, reason: "missing signature header" });
  });

  it("rejects a tampered body", () => {
    // Sign the real payload, then inflate the amount before sending.
    const original = JSON.stringify(chargeSuccess);
    const headers = sign(original);
    const tampered = JSON.stringify({
      ...chargeSuccess,
      data: { ...chargeSuccess.data, amount: 999_999_999 },
    });

    expect(provider.verifyWebhook(tampered, headers)).toEqual({
      valid: false,
      reason: "signature mismatch",
    });
  });

  it("is sensitive to whitespace, which is why the raw body must be used", () => {
    const body = JSON.stringify(chargeSuccess);
    const headers = sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);

    expect(provider.verifyWebhook(reserialised, headers).valid).toBe(false);
  });

  it("rejects a signed body that is not JSON", () => {
    const body = "not json at all";
    expect(provider.verifyWebhook(body, sign(body))).toEqual({
      valid: false,
      reason: "body is not valid JSON",
    });
  });

  it("rejects everything when no secret key is configured", () => {
    const unconfigured = new PaystackProvider("");
    const body = JSON.stringify(chargeSuccess);
    expect(unconfigured.verifyWebhook(body, sign(body)).valid).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("normalises a successful charge", () => {
    const event = provider.parseWebhook(chargeSuccess);

    expect(event.type).toBe("charge.success");
    expect(event.reference).toBe("jfk_c_abc123");
    expect(event.providerRef).toBe("302961");
    expect(event.amount!.format()).toBe("₦50,862.94");
    expect(event.fee!.format()).toBe("₦862.94");
  });

  it("extracts the reusable card token", () => {
    const event = provider.parseWebhook(chargeSuccess);

    expect(event.authorization).toMatchObject({
      authorizationCode: "AUTH_pmx3mgawyd",
      signature: "SIG_2Gvc6pNuzJmj4TCchXfp",
      last4: "4321",
      brand: "visa",
      bank: "GTBank",
      expMonth: 9,
      expYear: 2028,
      reusable: true,
    });
  });

  it("derives a stable event id so redeliveries collide", () => {
    const first = provider.parseWebhook(chargeSuccess);
    const second = provider.parseWebhook(structuredClone(chargeSuccess));
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toBe("charge.success:jfk_c_abc123");
  });

  it("gives a different id to a different event on the same reference", () => {
    const success = provider.parseWebhook(chargeSuccess);
    const failed = provider.parseWebhook({
      ...chargeSuccess,
      event: "charge.failed",
    });
    expect(success.eventId).not.toBe(failed.eventId);
  });

  it("normalises a failed charge and its reason", () => {
    const event = provider.parseWebhook({
      event: "charge.failed",
      data: {
        reference: "jfk_c_xyz",
        amount: 5_000_000,
        status: "failed",
        gateway_response: "Insufficient funds",
      },
    });

    expect(event.type).toBe("charge.failed");
    expect(event.failureReason).toBe("Insufficient funds");
    expect(event.authorization).toBeUndefined();
  });

  it("marks unrecognised events as unknown rather than guessing", () => {
    const event = provider.parseWebhook({
      event: "subscription.create",
      data: { reference: "x" },
    });
    expect(event.type).toBe("unknown");
  });

  it("survives a payload with almost nothing in it", () => {
    const event = provider.parseWebhook({});
    expect(event.type).toBe("unknown");
    expect(event.amount).toBeNull();
    expect(event.fee).toBeNull();
  });

  it("converts kobo to exact BigInt across the realistic range", () => {
    // Paystack sends amounts as JSON numbers, so they arrive through
    // JSON.parse as JS Numbers. That is exact below 2^53 kobo — about ₦90
    // trillion — which no contribution will ever approach. Everything from
    // there on is BigInt, so nothing downstream can lose a kobo.
    const amounts: [number, string][] = [
      [1, "₦0.01"],
      [5_086_294, "₦50,862.94"],
      [50_000_000_000, "₦500,000,000.00"],
    ];

    for (const [kobo, expected] of amounts) {
      const event = provider.parseWebhook({
        event: "charge.success",
        data: { reference: "r", amount: kobo, status: "success" },
      });
      expect(event.amount!.minor).toBe(BigInt(kobo));
      expect(event.amount!.format()).toBe(expected);
    }
  });
});

describe("chargeAuthorization", () => {
  it("reports a rejected request as a failed attempt, not a crash", async () => {
    const offline = new PaystackProvider("");
    const result = await offline.chargeAuthorization({
      authorizationCode: "AUTH_x",
      email: "geoffrey@jfk.test",
      amount: Money.fromMajor(50_000),
      reference: "jfk_c_1",
    });

    expect(result.accepted).toBe(false);
    expect(result.provisionalStatus).toBe("failed");
    expect(result.failureReason).toMatch(/not configured/);
  });
});
