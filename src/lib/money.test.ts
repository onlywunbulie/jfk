import { describe, expect, it } from "vitest";
import { Money, sumMoney } from "./money";

describe("Money construction", () => {
  it("builds from minor units", () => {
    expect(Money.fromMinor(5_000_000n).toDecimalString()).toBe("50000.00");
  });

  it("builds from major units without float error", () => {
    // The canonical float trap: 0.1 + 0.2 !== 0.3
    const a = Money.fromMajor("0.1");
    const b = Money.fromMajor("0.2");
    expect(a.plus(b).equals(Money.fromMajor("0.3"))).toBe(true);
    expect(a.plus(b).minor).toBe(30n);
  });

  it("handles the JFK Empire numbers exactly", () => {
    const contribution = Money.fromMajor(50_000);
    expect(contribution.minor).toBe(5_000_000n);
    expect(contribution.times(10).format()).toBe("₦500,000.00");
  });

  it("rejects fractional minor units", () => {
    expect(() => Money.fromMinor(10.5)).toThrow(/integer/);
  });

  it("rejects more precision than the currency supports", () => {
    expect(() => Money.fromMajor("1.234")).toThrow(/precision/);
  });

  it("rejects non-numeric input", () => {
    expect(() => Money.fromMajor("50,000")).toThrow(/non-numeric/);
  });

  it("round-trips negative amounts", () => {
    expect(Money.fromMajor("-1250.75").toDecimalString()).toBe("-1250.75");
  });
});

describe("Money arithmetic", () => {
  it("adds and subtracts exactly", () => {
    const balance = Money.fromMajor(500_000);
    const spend = Money.fromMajor(300_000);
    expect(balance.minus(spend).format()).toBe("₦200,000.00");
  });

  it("refuses to mix currencies", () => {
    const ngn = Money.fromMajor(100, "NGN");
    const usdc = Money.fromMajor(100, "USDC");
    expect(() => ngn.plus(usdc)).toThrow(/Cannot combine NGN with USDC/);
    expect(() => usdc.compare(ngn)).toThrow(/Cannot combine/);
    // Same digits, different money: equal minor units are not equal amounts.
    expect(Money.fromMinor(100, "NGN").equals(Money.fromMinor(100, "USDC"))).toBe(false);
  });

  it("rejects fractional multiplication factors", () => {
    expect(() => Money.fromMajor(100).times(1.5)).toThrow(/integer factor/);
  });
});

describe("Money.percentage — gateway fees", () => {
  it("computes 1.5% of a ₦50,000 contribution", () => {
    // Paystack local card: 1.5% + ₦100, capped at ₦2,000
    const contribution = Money.fromMajor(50_000);
    const percentPart = contribution.percentage(150);
    expect(percentPart.format()).toBe("₦750.00");
  });

  it("rounds half-up at the kobo boundary", () => {
    // 1 kobo * 50% = 0.5 kobo -> rounds up to 1
    expect(Money.fromMinor(1n).percentage(5_000).minor).toBe(1n);
    // 1 kobo * 49% = 0.49 kobo -> rounds down to 0
    expect(Money.fromMinor(1n).percentage(4_900).minor).toBe(0n);
  });

  it("rounds symmetrically for negative amounts", () => {
    expect(Money.fromMinor(-1n).percentage(5_000).minor).toBe(-1n);
  });

  it("never loses value to float math on awkward percentages", () => {
    const amount = Money.fromMajor("1999.99");
    expect(amount.percentage(150).toDecimalString()).toBe("30.00");
  });
});

describe("Money.split — remainder must never vanish", () => {
  it("splits ₦100 three ways without losing a kobo", () => {
    const parts = Money.fromMajor(100).split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual([
      "33.34",
      "33.33",
      "33.33",
    ]);
    expect(sumMoney(parts, "NGN").equals(Money.fromMajor(100))).toBe(true);
  });

  it("splits evenly when it divides cleanly", () => {
    const parts = Money.fromMajor(500_000).split(10);
    expect(parts).toHaveLength(10);
    expect(parts.every((p) => p.equals(Money.fromMajor(50_000)))).toBe(true);
  });

  it("preserves the total for every split size up to 50", () => {
    const total = Money.fromMajor("123456.78");
    for (let n = 1; n <= 50; n++) {
      expect(sumMoney(total.split(n), "NGN").equals(total)).toBe(true);
    }
  });

  it("preserves the total when splitting a negative amount", () => {
    const total = Money.fromMajor("-100.00");
    const parts = total.split(3);
    expect(sumMoney(parts, "NGN").equals(total)).toBe(true);
  });

  it("rejects a non-positive part count", () => {
    expect(() => Money.fromMajor(100).split(0)).toThrow(/Cannot split/);
  });
});

describe("Money comparison", () => {
  it("orders amounts", () => {
    const small = Money.fromMajor(100);
    const large = Money.fromMajor(300_000);
    expect(large.greaterThan(small)).toBe(true);
    expect(small.lessThan(large)).toBe(true);
    expect(small.greaterThanOrEqual(small)).toBe(true);
  });

  it("identifies sign and zero", () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.fromMajor(-1).isNegative()).toBe(true);
    expect(Money.fromMajor(1).isPositive()).toBe(true);
  });
});

describe("Money formatting", () => {
  it("groups thousands with the naira symbol", () => {
    expect(Money.fromMajor(500_000).format()).toBe("₦500,000.00");
    expect(Money.fromMajor("1234567.89").format()).toBe("₦1,234,567.89");
  });

  it("drops a .00 tail in compact mode but keeps real kobo", () => {
    expect(Money.fromMajor(50_000).format({ compact: true })).toBe("₦50,000");
    expect(Money.fromMajor("50000.50").format({ compact: true })).toBe("₦50,000.50");
  });

  it("formats negative amounts with the sign before the symbol", () => {
    expect(Money.fromMajor(-2_500).format()).toBe("-₦2,500.00");
  });

  it("serialises losslessly for persistence", () => {
    const amount = Money.fromMajor(500_000);
    expect(amount.toJSON()).toEqual({ minor: "50000000", currency: "NGN" });
  });

  it("survives amounts beyond Number.MAX_SAFE_INTEGER", () => {
    // ~₦92 quadrillion. Absurd for this product, but the type must not silently
    // lose precision if it ever sees a number that large.
    const huge = Money.fromMinor(9_007_199_254_740_993n);
    expect(huge.plus(Money.fromMinor(1n)).minor).toBe(9_007_199_254_740_994n);
  });
});

describe("sumMoney", () => {
  it("sums a full cycle of contributions", () => {
    const contributions = Array.from({ length: 10 }, () => Money.fromMajor(50_000));
    expect(sumMoney(contributions, "NGN").format()).toBe("₦500,000.00");
  });

  it("returns zero for an empty list", () => {
    expect(sumMoney([], "NGN").isZero()).toBe(true);
  });
});

describe("USDC — six decimal places, matching the token contract", () => {
  it("counts a dollar as one million minor units", () => {
    expect(Money.fromMajor(1, "USDC").minor).toBe(1_000_000n);
    expect(Money.fromMajor("50", "USDC").minor).toBe(50_000_000n);
  });

  it("holds the smallest amount the chain can, and nothing smaller", () => {
    expect(Money.fromMajor("0.000001", "USDC").minor).toBe(1n);
    expect(() => Money.fromMajor("0.0000001", "USDC")).toThrow(/6 decimal places/);
  });

  it("rejects a float too small to write without an exponent", () => {
    // String(1e-7) is "1e-7"; it must be refused, not misread as 1.
    expect(() => Money.fromMajor(1e-7, "USDC")).toThrow(/non-numeric/);
  });

  it("round-trips an on-chain amount exactly", () => {
    // What a balanceOf() call returns: a raw integer of base units.
    const raw = 123_456_789_012n;
    const money = Money.fromMinor(raw, "USDC");
    expect(money.toDecimalString()).toBe("123456.789012");
    expect(Money.fromMajor(money.toDecimalString(), "USDC").minor).toBe(raw);
    expect(BigInt(money.toJSON().minor)).toBe(raw);
  });

  it("does the classic float trap exactly at six places too", () => {
    const a = Money.fromMajor("0.1", "USDC");
    const b = Money.fromMajor("0.2", "USDC");
    expect(a.plus(b).equals(Money.fromMajor("0.3", "USDC"))).toBe(true);
  });

  it("reads like dollars: two places unless more carry a value", () => {
    expect(Money.fromMajor(50, "USDC").format()).toBe("$50.00");
    expect(Money.fromMajor(50, "USDC").format({ compact: true })).toBe("$50");
    expect(Money.fromMajor("1234.5", "USDC").format()).toBe("$1,234.50");
    expect(Money.fromMajor("0.123456", "USDC").format()).toBe("$0.123456");
    expect(Money.fromMajor("10.5001", "USDC").format()).toBe("$10.5001");
  });

  it("never displays a real amount as zero", () => {
    expect(Money.fromMinor(1n, "USDC").format()).toBe("$0.000001");
    expect(Money.fromMinor(1n, "USDC").format({ compact: true })).toBe("$0.000001");
    expect(Money.fromMinor(-1n, "USDC").format()).toBe("-$0.000001");
  });

  it("keeps full precision in the decimal string, even when display trims it", () => {
    expect(Money.fromMajor(50, "USDC").toDecimalString()).toBe("50.000000");
  });

  it("splits a pot without losing a base unit", () => {
    const pot = Money.fromMajor(100, "USDC");
    const shares = pot.split(3);
    expect(shares.map((s) => s.minor)).toEqual([33_333_334n, 33_333_333n, 33_333_333n]);
    expect(sumMoney(shares, "USDC").equals(pot)).toBe(true);
  });

  it("takes a percentage to the nearest base unit", () => {
    // 1.5% of $50 is exactly $0.75.
    expect(Money.fromMajor(50, "USDC").percentage(150).format()).toBe("$0.75");
    // 0.01% of $0.000050 is half a base unit: rounds half-up to one.
    expect(Money.fromMinor(50n, "USDC").percentage(100).minor).toBe(1n);
  });

  it("sums only with an explicit currency for an empty list", () => {
    expect(sumMoney([], "USDC").equals(Money.zero("USDC"))).toBe(true);
  });
});
