# Where Rallied is (handoff)

Read this first in a new session, then continue from **Next up**. Keep it current:
update it when a feature lands or a decision is made. Product rules the user set
are also in Claude's memory (`product-rules-nov`).

_Last updated: 2026-11-24._

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

## Waiting to be seen working live

- The first rotating payout: test group **Ajo Test** (vault
  0xb151f44e361780b7357ac9ce2d46f0f1472f8467) pays out 2026-11-25 07:00 UTC.
  Check #transactions ("Your turn, round 1") and #payout order ("Last payout").
- Voting through Claude; covering a debt; uploading an attached photo through
  Claude (needs code execution with network access in Claude's settings).

## Next up

1. **Notifications from both Rallied and Claude** (agreed in principle, not
   started): one live "what needs me" check across the user's groups; a Claude
   tool (`whats_new`) for a scheduled Claude task to call each morning; and
   Rallied's own daily email (Resend; the live site needs `RESEND_API_KEY` in
   Vercel). The user hasn't yet confirmed daily digest vs per-event emails.
2. Rotating groups in the rest of the app: #about, the sidebar and Claude's
   summary still read partly like a shared pot.
3. Warning when someone invited owes money in another Rallied group (agreed).
4. Before real money: see Claude memory `before-real-money` (collector key,
   v3 audit, backups), then contract v4 (`contracts/NEXT-VERSION.md`), then mainnet.
5. The user's own to-do: a free uptime monitor on `/api/health`.

## How to work here

- `AGENTS.md` has the commands and rules. Commit freely; push only when the user says.
- Full `pnpm test` now takes over 10 minutes: run it in the background, or run
  the affected folders (`npx vitest run src/modules/groups ...`).
- Contracts: `cd contracts && ~/.foundry/bin/forge test`.
