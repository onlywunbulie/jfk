import type { AgentDraft } from "@/lib/db/schema";
import { Money, toCurrency } from "@/lib/money";
import { shortAddress } from "@/lib/chain/addresses";
import type { GroupDetails, RoleDetails, RuleDetails, SpendDetails } from "@/modules/agents/drafts";
import type { DecisionDraftView, SpendDraftView } from "./propose";
import type { RuleDraftView } from "./edit-rules";
import type { RoleDraftView } from "./manage-roles";

/**
 * Turning a stored draft into what its Waiting section shows. Done on the
 * server so dates read the same on every screen (Lagos time) and never
 * mismatch when the page hydrates.
 */

const made = (draft: AgentDraft) =>
  `Drafted by ${draft.madeBy} · ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Lagos",
  }).format(draft.createdAt)}`;

export function spendDraftView(draft: AgentDraft): SpendDraftView {
  const details = draft.details as unknown as SpendDetails;
  const amount = Money.fromMinor(BigInt(details.amountMinor), toCurrency(details.currency));
  return {
    id: draft.id,
    what: details.what,
    amountLabel: `${amount.currency} ${amount.format({ compact: true, showSymbol: false })}`,
    amountMajor: Number(amount.toDecimalString()),
    paidTo:
      details.paidTo.kind === "member"
        ? `${details.paidTo.name} (member)`
        : `${shortAddress(details.paidTo.address)} (outside the group)`,
    receipt: details.receiptUrl,
    made: made(draft),
  };
}

export function ruleDraftView(draft: AgentDraft): RuleDraftView {
  const details = draft.details as unknown as RuleDetails;
  return {
    id: draft.id,
    rule: details.ruleLabel,
    before: details.before,
    after: details.after,
    starts: details.starts,
    money: details.money,
    made: made(draft),
  };
}

export function roleDraftView(draft: AgentDraft): RoleDraftView {
  const details = draft.details as unknown as RoleDetails;
  return {
    id: draft.id,
    label: details.label,
    change: details.change,
    wallet: details.wallet ? shortAddress(details.wallet) : null,
    made: made(draft),
  };
}

export function decisionDraftView(draft: AgentDraft, need: string): DecisionDraftView {
  const details = draft.details as unknown as GroupDetails;
  return { id: draft.id, label: details.label, detail: details.detail, need, made: made(draft) };
}
