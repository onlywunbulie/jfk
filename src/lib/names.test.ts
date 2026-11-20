import { describe, expect, it } from "vitest";
import { initialOf, isWalletName } from "@/lib/names";
import { shortAddress } from "@/lib/chain/addresses";

describe("names", () => {
  it("recognises the stand-in a wallet user starts with", () => {
    const stand_in = shortAddress("0x4fCb000000000000000000000000000000001f75");
    expect(isWalletName(stand_in)).toBe(true);
    expect(initialOf(stand_in)).toBeNull();
  });

  it("takes a real name's first letter", () => {
    expect(isWalletName("Amaka")).toBe(false);
    expect(initialOf("amaka eze")).toBe("A");
    expect(initialOf("Ọlá")).toBe("Ọ");
  });

  it("has no initial for an empty name", () => {
    expect(initialOf("  ")).toBeNull();
  });
});
