# JFK — Handoff

**Last updated:** 13 August 2026, after Phase 4.
**Status:** Phases 0–4 complete and committed. Phase 5 (governance) is next.
**Tests:** 289 passing. Typecheck, lint and build all clean.

This file has two audiences: Geoffrey, so you can see what exists without
reading code, and whoever picks the work up next. Read
[BLUEPRINT.md](./BLUEPRINT.md) for the full plan and [AGENTS.md](./AGENTS.md)
for the rules and gotchas.

---

## 1. What we're building

**JFK** — a private group treasury for you and your friends. Nigerian Ajo/Esusu,
digitized. A group agrees on a contribution, money is collected on a schedule,
it sits locked, and it only leaves when the group votes to release it.

The principle everything serves: **nobody can unilaterally take group money —
not even an admin, not even the owner.**

Two group types, one engine:
- **Treasury** — money accumulates and leaves only by proposal + vote.
- **Rotating (Ajo)** — each cycle the pot pays out to one member, in turn.

---

## 2. What actually works today

In plain terms, you can currently:

| You can | Where |
|---|---|
| Sign in with an emailed code (no password) | `/sign-in` |
| Create a group, pick treasury or rotating, set the contribution and cadence | `/groups/new` |
| Generate an invite link; someone opens it and joins | `/groups/[id]/members` → `/join/[code]` |
| See members, roles, and rotation payout order | `/groups/[id]/members` |
| Make someone an admin (owner only) | members page |
| Leave a group (owner can't — must transfer first) | members page |
| See a group's balance, split into available vs locked | `/groups/[id]` |
| See a transaction history of every movement | `/groups/[id]` |
| See all your groups and a combined total | `/` |
| See your saved cards and profile | `/wallet` |
| See the current cycle: who has paid, who hasn't, how much is in | `/groups/[id]` |
| See who is behind, and by how much | `/groups/[id]` → Behind |
| Run the automation by hand and travel through time | `pnpm jobs tick --at 2026-09-02` |
| Simulate contributions end-to-end without Paystack | Developer tools panel |

**Numbers in the seeded data:** JFK Empire holds ₦400,000 (₦100,000 available,
₦300,000 locked) with a live cycle. Family Ajo holds ₦60,000.

### What does NOT work yet

- **No proposals or voting.** Phase 5. So locked money currently has no way out.
- **No payouts.** Phase 6. No money can leave the system yet at all.
- **No chat, no notifications.** Phase 7.
- **No real card has ever been charged.** See §4.

---

## 3. How to run it

```bash
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm db:seed        # 2 groups, 4 users, prints session cookies
pnpm dev
```

Then open the printed URL (usually http://localhost:3002) and sign in as
`geoffrey@jfk.test` — **the 6-digit code prints in your terminal**, because no
email provider is configured.

> **One gotcha that will bite you:** the local database (PGlite) allows one
> process at a time. Stop `pnpm dev` before running `db:migrate`, `db:reset`,
> `db:seed` or `simulate`, or you'll get a confusing out-of-memory crash.
> This restriction vanishes the moment you point at a real Postgres server.

### Useful commands

| Command | Does |
|---|---|
| `pnpm test` | The whole test suite (248 tests) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Should all be clean |
| `pnpm db:reset` | Wipe local data and re-migrate |
| `pnpm simulate` | Run contributions through the real payment pipeline, no Paystack needed |
| `pnpm webhook:replay <ref>` | Fire a signed webhook at the running dev server |
| `pnpm jobs list` | What scheduled jobs exist |
| `pnpm jobs tick` | Run all of them, in order |
| `pnpm jobs run open-cycles --at 2026-09-02` | Run one job at a pretend date — how to fast-forward a month |

---

## 4. Testing it "like a live product"

You said you want to test with no simulation. Here is exactly what that needs.

**Step 1 — get Paystack test keys.** Sign up at paystack.com. Test keys are
free and available immediately, with no business verification. Copy the
**secret key** (`sk_test_…`) and the **public key** (`pk_test_…`).

**Step 2 — put them in `.env.local`:**

```
PAYSTACK_SECRET_KEY="sk_test_your_key_here"
NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY="pk_test_your_key_here"
```

**Step 3 — make webhooks reachable.** Paystack has to call your machine back.
Run a tunnel (`ngrok http 3002` or `cloudflared tunnel --url http://localhost:3002`),
then in the Paystack dashboard set the webhook URL to
`https://your-tunnel-url/api/webhooks/paystack`. Also set `APP_URL` in
`.env.local` to the tunnel URL so the card-setup redirect comes back correctly.

**Step 4 — add a card.** Go to `/wallet` → Add a card. Paystack's own page
opens; use their test card `4084 0840 8408 4081`, any future expiry, CVV `408`.
We charge ₦50 and it is refunded automatically.

**Step 5 — contribute.** Open a group → Contribute → Pay now.

**What to watch for:** the balance should move only *after* the webhook lands,
not when you click. That delay is deliberate and correct — money isn't real
until the bank says so.

**Still simulated even then:** nothing. With real keys this is the genuine
path. The only thing test mode changes is that no actual naira moves.

---

## 5. What's been built, phase by phase

Each phase is one commit. `git log --oneline` shows them.

**Phase 0 — Foundation.** Next.js 16 + TypeScript + Tailwind 4. Email OTP
sign-in with hashed session tokens. The `Money` type: all amounts are integer
kobo in a `bigint`, never a float. Dark design system. PGlite for local
Postgres (no Docker, no install).

**Phase 1 — Groups & permissions.** Groups, members, roles, invite links, both
group types. The centrepiece is `src/lib/auth/policy.ts` — one `can()` function
holding every permission rule, with a test that drives all 19 actions × 3 roles
from an explicit table. Every money-moving action returns "needs a proposal"
for *every* role, owner included.

**Phase 2 — The ledger.** Double-entry bookkeeping. Balances are calculated by
summing entries, never stored in a field that could drift. The invariants are
enforced by Postgres itself, not just application code: entries can never be
edited or deleted, every transaction must balance at commit time, and no group
account can go negative. A property test runs 250 random operations and checks
the books still add up.

**Phase 3 — Payments in.** Paystack adapter, card tokenization, webhook
endpoint. The rule: a webhook is the only thing that creates money. Duplicate
webhooks are impossible to double-count — tested by delivering the same event
three times. Fees: 1.5% + ₦100, capped ₦2,000, with **gross-up** as the default
so a ₦50,000 contribution charges ₦50,862.94 and the treasury receives exactly
₦50,000.

**Plus:** a dev-only simulator, so all of Phase 3 is testable without a
Paystack account. It refuses to run in production or with a live key.

**Phase 4 — Contributions & automation.** Cycles ("September 2026"), one
obligation per member per cycle, automatic collection from saved cards, a
retry ladder (+6h, +24h, +72h, then stop), arrears tracking, and the
contribution grid showing who has paid.

Two things worth knowing about it:

- **Only soft declines are retried.** "Insufficient funds" gets three more
  goes; "card expired" stops immediately, marks the card dead, and asks the
  member to add a new one. Retrying a revoked card is noise for everyone.
- **A rotating group with an underfunded cycle delays its payout** rather than
  handing someone a short pot. That was open decision #4 and I defaulted it.

**Deliberate deviation from the blueprint:** it specifies Inngest for
background jobs. Inngest needs a cloud account and cannot be tested offline,
so jobs are plain functions with their own idempotency table, runnable three
ways: the CLI (`pnpm jobs`), a secret-protected HTTP route (`/api/cron/<name>`),
or Inngest later as a thin trigger. The job bodies would not change.

---

## 6. Where I am right now

**About to start Phase 5 — Locks & governance.** This is the heart of the
product: proposals, voting, thresholds, and finally a way for locked money to
be released. Everything so far has been money coming *in*; this is where the
group decides what happens to it.

---

## 7. What comes after

| Phase | What | Why it matters |
|---|---|---|
| 5 | Locks & governance | Proposals, voting, thresholds. Locked money finally has a way out |
| 6 | Releases & payouts | Money actually leaves, via Paystack Transfers, only with an approved proposal |
| 7 | Chat, activity feed, notifications | Makes the group feel alive |
| 8 | Polish & hardening | Motion, empty states, rate limiting, error tracking |

---

## 8. Decisions still open

These are yours to make, not mine. From BLUEPRINT.md §22:

1. **Currency** — NGN only so far. Anyone abroad? Multi-currency touches the
   ledger's core, so decide before it gets expensive. *(Asked twice, unanswered.)*
2. **Fee policy** — I defaulted to gross-up (treasury gets round numbers, member
   pays the fee). Switchable per group. *(Asked once, unanswered — I proceeded.)*
3. **Leaving member's funds** — forfeit, refund on dissolution, or refund by
   proposal? Needed before Phase 5.
4. ~~**Rotating group underfunded**~~ — *defaulted to delay: nobody receives a
   short pot. Change in `closeCycle` if you disagree.*
5. ~~**Missed contributions**~~ — *defaulted to social-only. Arrears are shown
   plainly; JFK applies no penalties.*
6. **Group dissolution** — proportional split by contribution, or equal?
7. **"Freeze group" panic switch** — cheap now, valuable if an account is
   compromised.

---

## 9. Things you should know honestly

- **No real card has been charged.** Everything is tests + simulation. The first
  genuine ₦100 is still ahead, and it's the real test of Phase 3.
- **I can't click buttons.** I verify with tests and by fetching pages over
  HTTP. Interactive behaviour — a form actually submitting in a browser — is
  unverified. If something misbehaves on click, that's the likeliest place.
- **The UI is honest but unpolished.** It's dark, mobile-first and legible, but
  Phase 8 is where it gets the motion and finish. You wanted to work on the UI —
  the design tokens are in `src/app/globals.css` and components in
  `src/components/ui/`.
- **Risk #1 from the blueprint has not gone away:** with real keys, money settles
  into a bank account in *your* name, under your BVN. Say that out loud to the
  group before the first naira moves.

---

## 10. For whoever picks this up

- Read `AGENTS.md` first — it has the non-negotiable rules and every Next.js 16
  gotcha that has already cost time.
- `src/lib/db/testing.ts` gives any test a real, migrated in-memory Postgres.
  That is how the financial invariants get tested for real rather than mocked.
- Tests run sequentially on purpose; parallel WASM Postgres instances exhaust
  the heap.
- **Update this file before your context runs out.** That is a standing
  instruction from Geoffrey.
