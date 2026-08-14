# JFK — Handoff

**Last updated:** 13 August 2026, after voting shipped.
**Status:** Phases 0–5 complete and committed. Payouts are next.
**Tests:** 335 passing. Typecheck, lint and build all clean.

> ### ⚠️ Scope: this is a portfolio project
>
> JFK is built to be **demonstrated, not operated**. No real money will ever
> pass through it. Decided 13 August 2026; it governs everything below.
>
> **Deliberately out of scope:** live Paystack keys, CAC or business
> registration, real bank accounts, tax, and the custody questions that come
> with holding other people's money. Earlier drafts of this file and of
> BLUEPRINT.md treat those as live concerns — that framing no longer applies.
>
> **The demo path is the simulator.** `pnpm simulate` and the in-app Developer
> tools panel run the genuine payment pipeline with fabricated bank responses.
> Paystack *test* keys are optional and only add a real card form.
>
> **What matters instead:** a deployed link that works, an app that looks
> finished, and the interesting engineering being visible and explainable.

This file has two audiences: Geoffrey, so you can see what exists without
reading code, and whoever picks the work up next. See [AGENTS.md](./AGENTS.md)
for the rules and gotchas.

---

## 1. What we're building

**JFK** — a private group treasury, modelled on Nigerian Ajo/Esusu. A group
agrees on a contribution, money is collected on a schedule, it sits locked, and
it only leaves when the group votes to release it.

The principle everything serves: **nobody can unilaterally take group money —
not even an admin, not even the owner.** That constraint is what makes the
project worth building, and it is enforced in the database rather than by
convention.

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
| Propose a spend, vote on it, watch it pass or fail | `/groups/[id]/proposals` |
| Run the automation by hand and travel through time | `pnpm jobs tick --at 2026-09-02` |
| Simulate contributions end-to-end without Paystack | Developer tools panel |

**Numbers in the seeded data:** JFK Empire holds ₦400,000 (₦150,000 available,
₦250,000 locked), a live cycle, and a generator proposal mid-vote at 1–1.
Family Ajo holds ₦60,000.

### What does NOT work yet

- **No payouts.** Money still cannot leave the app. That is next.
- **No chat, no notifications.** Cut from scope — see §7.
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
| `pnpm test` | The whole test suite (335 tests) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Should all be clean |
| `pnpm db:reset` | Wipe local data and re-migrate |
| `pnpm simulate` | Run contributions through the real payment pipeline, no Paystack needed |
| `pnpm webhook:replay <ref>` | Fire a signed webhook at the running dev server |
| `pnpm jobs list` | What scheduled jobs exist |
| `pnpm jobs tick` | Run all of them, in order |
| `pnpm jobs run open-cycles --at 2026-09-02` | Run one job at a pretend date — how to fast-forward a month |

---

## 4. Demoing it

**The normal path needs no accounts and no setup.** Seed the database, open a
group, and use the **Developer tools** panel to simulate a contribution — or run
`pnpm simulate` from the terminal. Both push a fabricated bank response through
the genuine pipeline: signature check, duplicate guard, ledger posting. If any
of that were broken, the simulation would break too.

That is the demo. It is enough for a portfolio, and it is what a reviewer will
see.

### Optional: Paystack test keys

The only thing test keys add is a **real card form** — Paystack's own page,
their test card, a genuine round trip. Nice for a demo video, unnecessary
otherwise. It is still test mode: no naira moves.

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

**What to watch for:** the balance moves only *after* the bank's confirmation
lands, not when you click. That delay is deliberate — money isn't real until
the bank says so, and the app refuses to pretend otherwise.

**Never do this with live keys.** See the scope note at the top.

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

**Phase 5 — Voting.** Proposals, thresholds, and the first way for locked money
to be released. The vote maths lives in `governance/threshold.ts` as pure
functions with 27 tests, because the arithmetic that decides whether money
moves deserves to be exhaustively checked.

Three decisions worth knowing:

- **The rules are frozen when a proposal opens.** The threshold, the quorum and
  the number of eligible voters are snapshotted, so adding a member or editing
  the rules mid-vote cannot retroactively flip an outcome. Two tests prove it.
- **Approval reserves the money immediately.** The instant a vote passes, the
  amount moves from available to locked. Two proposals can therefore never both
  spend the same naira — the second is rejected at approval with an honest
  reason, rather than failing later at payout.
- **Votes are decided early when the arithmetic is settled.** If enough people
  have voted that no remaining vote could change the result, it closes there
  and then rather than waiting out the deadline.

---

## 6. Where I am right now

**About to start Phase 5 — Locks & governance.** This is the heart of the
product: proposals, voting, thresholds, and finally a way for locked money to
be released. Everything so far has been money coming *in*; this is where the
group decides what happens to it.

---

## 7. What comes after

Reordered on 13 August for portfolio scope: a deployed, finished-looking app
beats a longer feature list.

| Next | What | Why |
|---|---|---|
| 1 | **Payouts, simulated** | Money leaves — gated on an approved proposal. No live transfers |
| 2 | **Polish** | Motion, empty states, loading states. A rough-looking app hides a good ledger |
| 3 | **Deploy** | A live link is the single biggest factor in whether anyone looks |
| 4 | **README** | The story, screenshots, and a guided demo path |

**Cut:** chat and push notifications. Expensive to build, and every portfolio
project has chat. The activity feed survives — it is already half-built and
tells the money story.

---

## 8. Decisions still open

Most of the original list dissolved when the scope became portfolio-only.
What remains:

1. **Leaving member's funds** — forfeit, refund on dissolution, or refund by
   proposal? Refund-by-proposal is the coherent answer and is what I will build
   unless told otherwise.
2. **Group dissolution** — proportional split by contribution, or equal?
   Only matters if dissolution gets built at all; it is not on the list above.

**Settled by default** (change them if you disagree):
- *Fee policy* — gross-up, so the treasury receives round numbers.
- *Rotating group underfunded* — payout delays; nobody gets a short pot.
- *Missed contributions* — no penalties, shown plainly.
- *Currency* — NGN only.

---

## 9. Things you should know honestly

- **No real card has been charged, and none will be.** That is now the intended
  end state, not a gap.
- **I can't click buttons.** I verify with tests and by fetching pages over
  HTTP. Interactive behaviour — a form actually submitting in a browser — is
  unverified. If something misbehaves on click, that is the likeliest place,
  and it is the most valuable thing for you to test.
- **The UI is honest but unpolished.** Dark, mobile-first, legible, but the
  motion and finish come in the polish pass. Design tokens live in
  `src/app/globals.css`, components in `src/components/ui/`.
- **Anyone can currently sign up.** There is no allowlist: any email can request
  a code and create a group. Harmless for a demo, and arguably good for one —
  a reviewer can try it. Worth a line in the README so it reads as a choice
  rather than an oversight.
- **The blueprint still reads as though real money is coming.** Its §21 risks
  and §11 crypto strategy are now hypothetical. The engineering sections (§7–§10,
  §17) are still accurate and still what the project is judged on.

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
