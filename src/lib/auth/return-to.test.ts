import { describe, expect, it } from "vitest";
import { safeReturnTo, signInHref } from "./return-to";

describe("where sign-in may send someone back to", () => {
  it("allows a group's page, an invite, and the AI approval screen", () => {
    expect(safeReturnTo("/groups/01a1e9e2-1cc5-75cf-ad9d-8af9f41b7cba")).not.toBeNull();
    expect(safeReturnTo("/groups/01a1e9e2-1cc5-75cf-ad9d-8af9f41b7cba/edit-rules")).not.toBeNull();
    expect(safeReturnTo("/groups/01a1e9e2-1cc5-75cf-ad9d-8af9f41b7cba/transactions?filter=mine")).not.toBeNull();
    expect(safeReturnTo("/join/Ab3_x-9")).not.toBeNull();
    expect(safeReturnTo("/oauth/authorize?response_type=code&client_id=x")).not.toBeNull();
  });

  it("refuses other sites, however they're disguised", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example/groups/x",
      "/\\evil.example",
      "/groups/x/../../evil",
      "/groups/x/votes/extra",
      "javascript:alert(1)",
      "/sign-in",
      "/welcome",
      "",
      null,
      42,
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBeNull();
    }
  });

  it("builds the sign-in address, dropping anything not allowed", () => {
    expect(signInHref("/join/abc")).toBe("/sign-in?next=%2Fjoin%2Fabc");
    expect(signInHref("//evil.example")).toBe("/sign-in");
    expect(signInHref(null)).toBe("/sign-in");
  });
});
