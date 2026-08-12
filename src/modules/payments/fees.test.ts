import { describe, expect, it } from "vitest";
import { Money } from "@/lib/money";
import { estimateFee, netOf, planCharge, PAYSTACK_NG_LOCAL } from "./fees";

describe("estimateFee — Paystack Nigeria local cards", () => {
  it("charges 1.5% plus ₦100 in the normal range", () => {
    // Paystack's own worked example: ₦10,000 → ₦250 fee.
    expect(estimateFee(Money.fromMajor(10_000)).format()).toBe("₦250.00");
    expect(netOf(Money.fromMajor(10_000)).format()).toBe("₦9,750.00");
  });

  it("waives the ₦100 below ₦2,500 but still takes the percentage", () => {
    // ₦2,000 × 1.5% = ₦30, no flat fee.
    expect(estimateFee(Money.fromMajor(2_000)).format()).toBe("₦30.00");
  });

  it("applies the flat fee from ₦2,500 upward", () => {
    expect(estimateFee(Money.fromMajor(2_499)).format()).toBe("₦37.49");
    expect(estimateFee(Money.fromMajor(2_500)).format()).toBe("₦137.50");
  });

  it("caps the fee at ₦2,000", () => {
    // Paystack's own worked example: ₦200,000 → ₦2,000 (capped from ₦3,100).
    expect(estimateFee(Money.fromMajor(200_000)).format()).toBe("₦2,000.00");
    expect(netOf(Money.fromMajor(200_000)).format()).toBe("₦198,000.00");
  });

  it("never exceeds the cap however large the charge", () => {
    for (const amount of [126_000, 200_000, 1_000_000, 50_000_000]) {
      expect(
        estimateFee(Money.fromMajor(amount)).greaterThan(PAYSTACK_NG_LOCAL.cap),
      ).toBe(false);
    }
  });

  it("returns zero for a zero charge", () => {
    expect(estimateFee(Money.zero()).isZero()).toBe(true);
  });

  it("takes the standard fee on the JFK Empire contribution", () => {
    // ₦50,000 × 1.5% = ₦750, + ₦100 = ₦850.
    expect(estimateFee(Money.fromMajor(50_000)).format()).toBe("₦850.00");
  });
});

describe("planCharge — absorb mode", () => {
  it("charges the headline amount and gives the treasury the rest", () => {
    const plan = planCharge(Money.fromMajor(50_000), false);

    expect(plan.charged.format()).toBe("₦50,000.00");
    expect(plan.fee.format()).toBe("₦850.00");
    expect(plan.net.format()).toBe("₦49,150.00");
    expect(plan.memberPremium.isZero()).toBe(true);
  });
});

describe("planCharge — gross-up mode", () => {
  it("charges enough for the treasury to receive a clean ₦50,000", () => {
    const plan = planCharge(Money.fromMajor(50_000), true);

    // The charge carries the awkward kobo so the treasury doesn't: the card
    // is debited ₦50,862.94, Paystack takes ₦862.94, and the group's books
    // read exactly ₦50,000.00 — the number everyone agreed on.
    expect(plan.net.format()).toBe("₦50,000.00");
    expect(plan.charged.format()).toBe("₦50,862.94");
    expect(plan.memberPremium.format()).toBe("₦862.94");
  });

  it("never leaves the treasury short, across the whole range", () => {
    const targets = [
      1, 50, 100, 999, 2_400, 2_460, 2_461, 2_462, 2_463, 2_500, 5_000, 10_000,
      49_999, 50_000, 100_000, 124_000, 124_666, 124_667, 125_000, 200_000,
      1_000_000,
    ];

    for (const naira of targets) {
      const target = Money.fromMajor(naira);
      const plan = planCharge(target, true);

      // The treasury must always get at least what was asked for.
      expect(
        plan.net.greaterThanOrEqual(target),
        `net ${plan.net.format()} < target ${target.format()}`,
      ).toBe(true);

      // And never more than a kobo over — rounding, not overcharging.
      expect(
        plan.net.minus(target).lessThan(Money.fromMinor(2n)),
        `net ${plan.net.format()} overshoots ${target.format()}`,
      ).toBe(true);

      // The plan must be internally consistent.
      expect(plan.charged.minus(plan.fee).equals(plan.net)).toBe(true);
      expect(plan.fee.equals(estimateFee(plan.charged))).toBe(true);
    }
  });

  it("finds the minimum charge — one kobo less would fall short", () => {
    for (const naira of [2_000, 10_000, 50_000, 200_000]) {
      const target = Money.fromMajor(naira);
      const plan = planCharge(target, true);
      const oneLess = plan.charged.minus(Money.fromMinor(1n));

      expect(
        netOf(oneLess).lessThan(target),
        `${plan.charged.format()} is not minimal for ${target.format()}`,
      ).toBe(true);
    }
  });

  it("handles the capped regime as a flat ₦2,000 addition", () => {
    const plan = planCharge(Money.fromMajor(200_000), true);
    expect(plan.charged.format()).toBe("₦202,000.00");
    expect(plan.fee.format()).toBe("₦2,000.00");
    expect(plan.net.format()).toBe("₦200,000.00");
  });

  it("handles small charges where the flat fee is waived", () => {
    const plan = planCharge(Money.fromMajor(1_000), true);
    expect(plan.net.greaterThanOrEqual(Money.fromMajor(1_000))).toBe(true);
    // Under ₦2,500 the ₦100 is waived, so the premium is just the percentage.
    expect(plan.memberPremium.lessThan(Money.fromMajor(20))).toBe(true);
  });

  it("handles a target that straddles the ₦2,500 flat-fee boundary", () => {
    // A target just under ₦2,500 grosses up past the threshold, so the flat
    // fee suddenly applies. The refinement must cope with that discontinuity.
    for (const naira of [2_400, 2_450, 2_462, 2_470, 2_499]) {
      const target = Money.fromMajor(naira);
      const plan = planCharge(target, true);
      expect(plan.net.greaterThanOrEqual(target)).toBe(true);
      expect(plan.fee.equals(estimateFee(plan.charged))).toBe(true);
    }
  });

  it("rejects a non-positive target", () => {
    expect(() => planCharge(Money.zero(), true)).toThrow(/must be positive/);
    expect(() => planCharge(Money.fromMajor(-100), true)).toThrow(/must be positive/);
  });
});
