import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));
const { VoteRing } = await import("@/app/(app)/groups/[groupId]/[channel]/vote-ring");
const { yesNeeded } = await import("@/modules/groups/onchain-votes");

describe("the vote ring", () => {
  it("counts people the way the contract rounds", () => {
    expect(yesNeeded(667, 3)).toBe(2); // 2 of 3 is 66.7%
    expect(yesNeeded(750, 8)).toBe(6);
    expect(yesNeeded(800, 3)).toBe(3);
    expect(yesNeeded(500, 4)).toBe(2);
    expect(yesNeeded(667, 1)).toBe(1);
  });

  it("draws one block per member, filled for yes and no, with the count against what's needed", () => {
    const html = renderToStaticMarkup(createElement(VoteRing, { yes: 1, no: 1, eligible: 3, neededYes: 2 }));
    expect(html.match(/<path /g)).toHaveLength(3);
    expect(html.match(/stroke-accent/g)).toHaveLength(1);
    expect(html.match(/stroke-danger/g)).toHaveLength(1);
    expect(html).toContain('aria-label="1 of 3 voted yes; 2 needed"');
    expect(html).toContain("of 2 needed");
  });
});
