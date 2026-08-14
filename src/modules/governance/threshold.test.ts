import { describe, expect, it } from "vitest";
import { evaluate, whatIsNeeded, formatPermille } from "./threshold";

/** The JFK Empire defaults: 10 members, 66.7% approval, 60% quorum. */
const base = {
  eligibleVoters: 10,
  thresholdPermille: 667,
  quorumPct: 60,
};

describe("the worked example from the brief", () => {
  it("approves a ₦300,000 spend once 7 of 10 agree", () => {
    // 7 yes, 3 no — everyone has voted, 70% approval clears 66.7%.
    const result = evaluate({ ...base, yes: 7, no: 3, abstain: 0 });
    expect(result.decision).toBe("approved");
    expect(result.approvalPermille).toBe(700);
  });

  it("rejects it when only 6 of 10 agree", () => {
    // 60% approval misses the 66.7% bar.
    const result = evaluate({ ...base, yes: 6, no: 4, abstain: 0 }, true);
    expect(result).toMatchObject({ decision: "rejected", reason: "threshold_missed" });
  });
});

describe("abstentions", () => {
  it("count toward quorum but not the ratio", () => {
    // 6 yes, 2 no, 2 abstain. Ratio is 6/8 = 75%, which passes.
    // Turnout is 10/10, so quorum passes too.
    const result = evaluate({ ...base, yes: 6, no: 2, abstain: 2 });
    expect(result.decision).toBe("approved");
    expect(result.approvalPermille).toBe(750);
    expect(result.turnoutPct).toBe(100);
  });

  it("cannot rescue a proposal that the decisive votes rejected", () => {
    // 3 yes, 5 no, 2 abstain. Abstentions give quorum but the ratio is 37.5%.
    const result = evaluate({ ...base, yes: 3, no: 5, abstain: 2 }, true);
    expect(result).toMatchObject({ decision: "rejected" });
    expect(result.approvalPermille).toBe(375);
  });

  it("lets an all-abstain vote fail rather than divide by zero", () => {
    const result = evaluate({ ...base, yes: 0, no: 0, abstain: 10 }, true);
    expect(result.decision).toBe("rejected");
    expect(result.approvalPermille).toBe(0);
  });
});

describe("quorum", () => {
  it("rejects a lopsided vote nobody turned up for", () => {
    // 3 yes, 0 no — 100% approval, but only 30% turnout against a 60% bar.
    const result = evaluate({ ...base, yes: 3, no: 0, abstain: 0 }, true);
    expect(result).toMatchObject({ decision: "rejected", reason: "quorum_missed" });
    expect(result.approvalPermille).toBe(1000);
  });

  it("accepts turnout exactly on the bar", () => {
    // 6 of 10 voted = 60%, meeting the 60% requirement exactly.
    const result = evaluate({ ...base, yes: 6, no: 0, abstain: 0 }, true);
    expect(result.decision).toBe("approved");
    expect(result.turnoutPct).toBe(60);
  });
});

describe("threshold boundaries", () => {
  it("treats the threshold as 'at least', not 'more than'", () => {
    // Exactly 50% against a 50% bar must pass.
    const result = evaluate(
      { eligibleVoters: 10, thresholdPermille: 500, quorumPct: 60, yes: 5, no: 5, abstain: 0 },
      true,
    );
    expect(result.decision).toBe("approved");
    expect(result.approvalPermille).toBe(500);
  });

  it("fails a tie whenever the threshold is above half", () => {
    // 5–5 is 50%, short of 66.7%. No coin flips, no admin casting vote.
    const result = evaluate({ ...base, yes: 5, no: 5, abstain: 0 }, true);
    expect(result).toMatchObject({ decision: "rejected", reason: "threshold_missed" });
  });

  it("passes at exactly 66.7% with the standard 10-member group", () => {
    // 2 of 3 decisive votes = 667 permille exactly.
    const result = evaluate({ ...base, yes: 6, no: 3, abstain: 1 }, true);
    expect(result.approvalPermille).toBe(667);
    expect(result.decision).toBe("approved");
  });

  it("holds the line one vote below the bar", () => {
    const result = evaluate({ ...base, yes: 5, no: 3, abstain: 2 }, true);
    expect(result.approvalPermille).toBe(625);
    expect(result.decision).toBe("rejected");
  });
});

describe("deciding early", () => {
  it("approves as soon as the outcome cannot change", () => {
    // 8 yes, 0 no, 2 still to vote. Even both voting no gives 8/10 = 80%,
    // still above 66.7%, so waiting achieves nothing.
    const result = evaluate({ ...base, yes: 8, no: 0, abstain: 0 });
    expect(result.decision).toBe("approved");
  });

  it("waits while a late no could still change things", () => {
    // 6 yes, 1 no, 3 to vote. If all three vote no it becomes 6/10 = 60%,
    // which fails — so the result is genuinely still open.
    const result = evaluate({ ...base, yes: 6, no: 1, abstain: 0 });
    expect(result.decision).toBe("undecided");
  });

  it("rejects as soon as the threshold is out of reach", () => {
    // 4 no already. Best case is 6 yes vs 4 no = 60%, short of 66.7%.
    const result = evaluate({ ...base, yes: 0, no: 4, abstain: 0 });
    expect(result).toMatchObject({
      decision: "rejected",
      reason: "threshold_unreachable",
    });
  });

  it("does not call a proposal unreachable while it is still winnable", () => {
    // 3 no, 7 could still vote yes: 7/10 = 70%, which clears the bar.
    const result = evaluate({ ...base, yes: 0, no: 3, abstain: 0 });
    expect(result.decision).toBe("undecided");
  });

  it("stays undecided before anyone has voted", () => {
    const result = evaluate({ ...base, yes: 0, no: 0, abstain: 0 });
    expect(result.decision).toBe("undecided");
    expect(result.approvalPermille).toBe(0);
  });
});

describe("what is still needed", () => {
  it("reports the yes votes and turnout still required", () => {
    const needed = whatIsNeeded({ ...base, yes: 3, no: 1, abstain: 0 });
    // 3/4 is already 75%, so no more yes votes are needed for the ratio…
    expect(needed.moreYesVotes).toBe(0);
    // …but only 4 of 10 have voted, and quorum needs 6.
    expect(needed.moreVotesForQuorum).toBe(2);
  });

  it("counts the yes votes needed to overcome existing opposition", () => {
    const needed = whatIsNeeded({ ...base, yes: 1, no: 2, abstain: 0 });
    // Needs 4 yes vs 2 no = 66.7%.
    expect(needed.moreYesVotes).toBe(3);
  });

  it("reports nothing needed once a proposal already passes", () => {
    const needed = whatIsNeeded({ ...base, yes: 7, no: 3, abstain: 0 });
    expect(needed).toEqual({ moreYesVotes: 0, moreVotesForQuorum: 0 });
  });

  it("never asks for more votes than remain", () => {
    const needed = whatIsNeeded({ ...base, yes: 0, no: 9, abstain: 0 });
    expect(needed.moreYesVotes).toBeLessThanOrEqual(1);
  });
});

describe("small groups", () => {
  it("handles a two-person group", () => {
    const both = evaluate(
      { eligibleVoters: 2, thresholdPermille: 667, quorumPct: 60, yes: 2, no: 0, abstain: 0 },
      true,
    );
    expect(both.decision).toBe("approved");

    const split = evaluate(
      { eligibleVoters: 2, thresholdPermille: 667, quorumPct: 60, yes: 1, no: 1, abstain: 0 },
      true,
    );
    expect(split.decision).toBe("rejected");
  });

  it("handles a group of one without dividing by zero", () => {
    const result = evaluate(
      { eligibleVoters: 1, thresholdPermille: 667, quorumPct: 60, yes: 1, no: 0, abstain: 0 },
      true,
    );
    expect(result.decision).toBe("approved");
    expect(result.turnoutPct).toBe(100);
  });

  it("survives an empty group", () => {
    const result = evaluate(
      { eligibleVoters: 0, thresholdPermille: 667, quorumPct: 60, yes: 0, no: 0, abstain: 0 },
      true,
    );
    expect(result.decision).toBe("rejected");
    expect(result.turnoutPct).toBe(0);
  });
});

describe("every default threshold behaves sensibly", () => {
  const thresholds = [500, 667, 750, 800];

  it("approves unanimous support at every level", () => {
    for (const thresholdPermille of thresholds) {
      const result = evaluate(
        { eligibleVoters: 10, quorumPct: 60, thresholdPermille, yes: 10, no: 0, abstain: 0 },
        true,
      );
      expect(result.decision, `threshold ${thresholdPermille}`).toBe("approved");
    }
  });

  it("rejects unanimous opposition at every level", () => {
    for (const thresholdPermille of thresholds) {
      const result = evaluate(
        { eligibleVoters: 10, quorumPct: 60, thresholdPermille, yes: 0, no: 10, abstain: 0 },
        true,
      );
      expect(result.decision, `threshold ${thresholdPermille}`).toBe("rejected");
    }
  });

  it("gets harder to pass as the threshold rises", () => {
    // 7 yes / 3 no = 70%: clears 50% and 66.7%, misses 75% and 80%.
    const tally = { eligibleVoters: 10, quorumPct: 60, yes: 7, no: 3, abstain: 0 };

    expect(evaluate({ ...tally, thresholdPermille: 500 }, true).decision).toBe("approved");
    expect(evaluate({ ...tally, thresholdPermille: 667 }, true).decision).toBe("approved");
    expect(evaluate({ ...tally, thresholdPermille: 750 }, true).decision).toBe("rejected");
    expect(evaluate({ ...tally, thresholdPermille: 800 }, true).decision).toBe("rejected");
  });
});

describe("formatPermille", () => {
  it("renders whole and fractional percentages readably", () => {
    expect(formatPermille(500)).toBe("50%");
    expect(formatPermille(667)).toBe("66.7%");
    expect(formatPermille(750)).toBe("75%");
    expect(formatPermille(800)).toBe("80%");
  });
});
