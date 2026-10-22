import { describe, expect, it } from "vitest";
import { DEFAULT_GOVERNANCE } from "@/lib/db/schema";
import {
  answer,
  buildScript,
  formatDollars,
  resolveThresholds,
  toFormFields,
  type Answers,
  type TextQuestion,
} from "./script";

const ids = (answers: Answers) => buildScript(answers).map((q) => q.id);

const text = (answers: Answers, id: string) =>
  buildScript(answers).find((q) => q.id === id) as TextQuestion;

/** Answer every question with its first choice, or the given text. */
function finish(start: Answers, typed: Record<string, string>): Answers {
  let answers = start;
  for (let guard = 0; guard < 50; guard++) {
    const next = buildScript(answers).find((q) => answers[q.id] === undefined);
    if (!next) return answers;
    const value =
      next.kind === "choice" ? (typed[next.id] ?? next.choices[0].value) : typed[next.id];
    answers = answer(answers, next.id, value);
  }
  throw new Error("the conversation never ended");
}

describe("the create-group conversation", () => {
  it("asks nine questions when the suggested rules are accepted", () => {
    expect(ids({})).toEqual([
      "name",
      "description",
      "type",
      "amount",
      "cadence",
      "dueDay",
      "rules",
      "quorumPct",
      "membersCanPropose",
    ]);
  });

  it("asks for a date in a monthly group and a weekday in a weekly one", () => {
    const monthly = buildScript({ cadence: "MONTHLY" }).find((q) => q.id === "dueDay");
    const weekly = buildScript({ cadence: "WEEKLY" }).find((q) => q.id === "dueDay");

    expect(monthly?.kind).toBe("text");
    expect(weekly?.kind).toBe("choice");
    expect(weekly?.display("5")).toBe("Fridays");
  });

  it("only asks about each threshold when you choose to set your own", () => {
    expect(ids({ rules: "recommended" })).not.toContain("threshold.DISSOLVE_GROUP");

    const custom = ids({ rules: "custom", type: "TREASURY" });
    expect(custom).toContain("threshold.FUND_RELEASE_SMALL");
    expect(custom).toContain("threshold.DISSOLVE_GROUP");
    // A treasury has no payout order to vote on.
    expect(custom).not.toContain("threshold.ROTATION_ORDER_CHANGE");
    expect(ids({ rules: "custom", type: "ROTATING" })).toContain(
      "threshold.ROTATION_ORDER_CHANGE",
    );
  });
});

describe("plain language", () => {
  // The words that made the first version of this flow read like a bank form.
  const JARGON = /treasury|threshold|quorum|routine spend|withdrawal|proposal|dissolve|governance|permille/i;

  it("never uses the internal terms, whichever way the conversation goes", () => {
    const conversations: Answers[] = [
      {},
      { cadence: "WEEKLY", rules: "custom", type: "ROTATING" },
      { cadence: "MONTHLY", rules: "custom", type: "TREASURY" },
    ];
    for (const answers of conversations) {
      for (const question of buildScript(answers)) {
        const said = [
          question.ask,
          question.detail ?? "",
          ...(question.facts ?? []).flatMap((fact) => [fact.label, fact.value]),
          ...(question.kind === "choice"
            ? question.choices.flatMap((c) => [c.label, c.hint ?? "", question.display(c.value)])
            : [question.placeholder]),
        ].join(" ");

        expect(said, question.id).not.toMatch(JARGON);
      }
    }
  });

  it("explains what a small amount is wherever the idea comes up", () => {
    const rules = buildScript({}).find((q) => q.id === "rules");
    const small = buildScript({ rules: "custom" }).find(
      (q) => q.id === "threshold.FUND_RELEASE_SMALL",
    );

    expect(rules?.detail).toMatch(/one fifth \(20%\)/);
    expect(small?.detail).toMatch(/one fifth \(20%\)/);
  });

  it("says how many must agree in everyday words", () => {
    const rules = buildScript({}).find((q) => q.id === "rules");
    expect(rules?.facts?.[0]).toEqual({
      label: "To spend a small amount",
      value: "Half of the group",
    });
  });
});

describe("validating what was typed", () => {
  it("needs a real name", () => {
    const name = text({}, "name");
    expect(name.validate(name.normalise("  J "))).toMatch(/name/);
    expect(name.validate(name.normalise("  JFK Empire "))).toBeNull();
  });

  it("accepts an amount however people write it, and nothing that isn't one", () => {
    const amount = text({}, "amount");
    expect(amount.normalise("$1,000")).toBe("1000");
    expect(amount.normalise("$ 50")).toBe("50");
    expect(amount.validate("50000")).toBeNull();
    expect(amount.validate("2500.50")).toBeNull();
    expect(amount.validate("0")).toMatch(/more than zero/);
    expect(amount.validate("0.00")).toMatch(/more than zero/);
    expect(amount.validate("fifty")).toMatch(/amount/);
    expect(amount.validate("10.999")).toMatch(/amount/);
  });

  it("keeps a monthly due day inside 1 to 28", () => {
    const day = text({ cadence: "MONTHLY" }, "dueDay");
    expect(day.validate(day.normalise("15th"))).toBeNull();
    expect(day.validate("28")).toBeNull();
    expect(day.validate("29")).toMatch(/1 to 28/);
    expect(day.validate("0")).toMatch(/1 to 28/);
  });

  it("lets the description be skipped", () => {
    const description = text({ name: "JFK Empire" }, "description");
    expect(description.skipLabel).toBeDefined();
    expect(description.validate("")).toBeNull();
    expect(description.ask).toContain("JFK Empire");
  });
});

describe("changing an earlier answer", () => {
  it("asks for the due day again when weekly becomes monthly", () => {
    const weekly = { cadence: "WEEKLY", dueDay: "7", name: "JFK" };
    const changed = answer(weekly, "cadence", "MONTHLY");

    expect(changed.dueDay).toBeUndefined();
    expect(changed.name).toBe("JFK");
  });

  it("keeps the due day when the same cadence is picked again", () => {
    expect(answer({ cadence: "WEEKLY", dueDay: "3" }, "cadence", "WEEKLY").dueDay).toBe("3");
  });

  it("forgets hand-picked thresholds on going back to the suggested rules", () => {
    const custom = { rules: "custom", "threshold.DISSOLVE_GROUP": "1000" };
    const changed = answer(custom, "rules", "recommended");

    expect(changed["threshold.DISSOLVE_GROUP"]).toBeUndefined();
    expect(resolveThresholds(changed)).toEqual(DEFAULT_GOVERNANCE);
  });
});

describe("what gets posted at the end", () => {
  const typed = { name: "JFK Empire", description: "", amount: "50000", dueDay: "1" };

  it("matches the fields the server action reads, with defaults for the rules", () => {
    const fields = Object.fromEntries(toFormFields(finish({}, typed)));

    expect(fields).toMatchObject({
      name: "JFK Empire",
      description: "",
      type: "TREASURY",
      amount: "50000",
      cadence: "MONTHLY",
      dueDay: "1",
      quorumPct: "40",
      membersCanPropose: "on",
      "threshold.FUND_RELEASE_SMALL": "500",
      "threshold.DISSOLVE_GROUP": "800",
    });
    // Every governed action is sent, including ones that were never asked.
    expect(fields["threshold.ROTATION_ORDER_CHANGE"]).toBe("667");
  });

  it("carries hand-picked thresholds through", () => {
    const answers = finish({}, {
      ...typed,
      rules: "custom",
      "threshold.FUND_RELEASE_SMALL": "1000",
    });
    const fields = Object.fromEntries(toFormFields(answers));

    expect(fields["threshold.FUND_RELEASE_SMALL"]).toBe("1000");
  });

  it("leaves the checkbox field out entirely for admins-only", () => {
    const answers = finish({}, { ...typed, membersCanPropose: "no" });
    expect(toFormFields(answers).map(([name]) => name)).not.toContain("membersCanPropose");
  });
});

describe("formatDollars", () => {
  it("groups thousands and always shows cents as two digits", () => {
    expect(formatDollars("50")).toBe("$50");
    expect(formatDollars("1250000.50")).toBe("$1,250,000.50");
    expect(formatDollars("12.5")).toBe("$12.50");
    expect(formatDollars("0.05")).toBe("$0.05");
  });
});
