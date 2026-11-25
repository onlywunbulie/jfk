# Where Rallied is (handoff)

Read this first in a new session, then continue from **Next up**. Keep it current:
update it when a feature lands or a decision is made. Product rules the user set
are also in Claude's memory (`product-rules-nov`).

_Last updated: 2026-11-25._

## Live

- **Site:** https://getrallied.vercel.app (Vercel + Neon), deploys on push to `master`.
- **Network:** Base Sepolia (test money only).
- **Contracts:** v3 `JfkModule` 0x48bB48799153c1a420B8476EaC663C396E291655 and
  `JfkSetup` 0xF44DF78ba5BaA9a3F836E446af99930389196f10 (record:
  `contracts/deployments/base-sepolia.json`). New groups start on v3; groups
  started before 2026-11-20 stay on v2, and `src/lib/chain/module.ts` reads
  which contract each vault uses.

## Working

- Wallet sign-in; groups created in Rallied (Rall's chat) or by Claude; start on Base.
- Dues by hand and automatic (daily job, 07:00 UTC); votes on spends, members,
  rules, amount, closing, the payout order; passed votes carried out on Base.
- **Rotating savings (Ajo), contract v3:** turns paid automatically on the due
  date; missed rounds become public debts repaid to whoever was short; miss
  before your turn and you collect last; dues locked on after your turn;
  cycles roll on; anyone can cover a debt. Automatic dues are required (in the
  app; v3 can't enforce it).
- **Claude (MCP, `src/modules/agents/mcp.ts`):** read groups and votes, create
  groups, draft every proposal type, invite links, start on Base, automatic
  dues, pay dues, delete a group, change the payout order, cover a debt, set a
  group picture/banner from a link or upload an attached file, and **vote** for
  the user where they allowed it (`/ai-votes/<group>`).
- Group pictures and banners (Vercel Blob), Discord-style group profile panel.
- Polish: no pills, loading/error screens, $ everywhere, quiet scrollbars,
  Iconoir icons, names for wallet users, connect-Claude reminder.
- **Notifications (no email, by the user's choice)** in `src/modules/notifications`:
  Rallied reads Base for what needs each member (new vote, last day to vote,
  result, your turn paid, a round owed, dues by hand due, automatic dues
  failing; plus someone covering your debt, checked against the covering
  transaction, and someone joining a group not yet on Base), stores each once
  (`notifications`, unique key per user), and alerts their devices by Web
  Push. Checked right after a proposal is sent or a vote cast (in Rallied or
  by Claude) and in the 07:00 job. The bell on the rail lists them; the
  profile has an Alerts switch; a bar offers alerts once (iPhone: Add to Home
  Screen first). Claude's `whats_new` tool reads the same check.
- Rotating groups show this round and the next payout (sidebar, #general,
  #about dues, #transactions, Claude's list_groups), not a balance.
- A vote to add someone who owes in another rotating group warns how much
  (never which group), on the vote card and in Claude's list_proposals.
- A separate helper key (`HELPER_PRIVATE_KEY`, `src/lib/chain/helper-key.ts`)
  collects automatic dues and casts AI votes; the fee wallet only pays fees,
  starts groups, carries out votes and pays turns. Setups on the old key keep
  working and show "Renew once". Unset, the fee wallet does both jobs.

## Waiting to be seen working live

- The first rotating payout: test group **Ajo Test** (vault
  0xb151f44e361780b7357ac9ce2d46f0f1472f8467) pays out 2026-11-25 07:00 UTC.
  Check #transactions ("Your turn, round 1") and #payout order ("Last payout").
- Alerts on a real phone: needs `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY` in Vercel (`npx web-push generate-vapid-keys`), then a
  redeploy. Then a morning Claude task that calls whats_new.
- Voting through Claude; covering a debt; uploading an attached photo through
  Claude (needs code execution with network access in Claude's settings).

## Next up

1. Before real money: see Claude memory `before-real-money` (collector key,
   v3 audit, backups), then contract v4 (`contracts/NEXT-VERSION.md`), then mainnet.
2. The user's own to-do: a free uptime monitor on `/api/health`.

## How to work here

- `AGENTS.md` has the commands and rules. Commit freely; push only when the user says.
- Full `pnpm test` now takes over 10 minutes: run it in the background, or run
  the affected folders (`npx vitest run src/modules/groups ...`).
- Contracts: `cd contracts && ~/.foundry/bin/forge test`.
