# JFK

A savings app for friend groups, built around **Ajo** (also called Esusu): everyone puts in the
same amount on a schedule, and the money only goes anywhere when the group agrees.

The one rule everything is built around: **nobody can take the group's money on their own.** Not
an admin, not the owner, not me.

> **Heads up: this is mid-rebuild.** The version in this repo works end to end on Paystack and
> Postgres. I'm now rebuilding it onchain, on Base, so the money sits in a shared wallet nobody
> controls instead of in my own Paystack account. The plan is in
> [BLUEPRINT-WEB3.md](./BLUEPRINT-WEB3.md), and I'm building it in public.

## What works today

- Sign in with an emailed code, no password
- Create a group by answering a few questions, as either **save together** (money builds up and
  leaves only by vote) or **take turns** (each round, one person collects the whole pot)
- Invite friends with a link
- Contributions collected on a schedule, with who's paid and who's behind
- Propose a spend, vote on it, and pay it out once it passes
- A dashboard with the balance, what each month raised, and every movement of money

No real money has ever moved through it. Payments run through a simulator that pushes fake bank
responses through the real pipeline.

## Running it

```bash
pnpm install
cp .env.example .env.local   # the defaults work for local dev
pnpm db:migrate
pnpm db:seed                 # two groups and four users
pnpm dev
```

Sign in as `geoffrey@jfk.test`. With no email provider set up, the sign-in code shows in the
terminal and on the sign-in page.

There's no database to install: locally it runs PGlite, which is real Postgres running inside
Node. Stop `pnpm dev` before running `db:migrate`, `db:reset` or `db:seed`, because only one
process can use it at a time.

| Command | Does |
|---|---|
| `pnpm test` | The test suite (a few hundred tests, many against a real in-memory Postgres) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Checks |
| `pnpm simulate` | Push contributions through the payment pipeline without Paystack |
| `pnpm jobs tick --at 2026-09-02` | Run the scheduled jobs at a pretend date, to fast-forward a month |

## The parts I'm proudest of

- **Money is never a float.** Every amount is whole kobo in a `bigint`, and splitting money has
  to say where the remainder goes.
- **A double-entry ledger** where Postgres itself refuses an unbalanced transaction, an edit to
  history, or a group balance going negative. A bug in my code can't corrupt the books; it can
  only fail loudly.
- **No payout without an approved vote**, enforced by a database constraint rather than an `if`
  statement.
- **Webhooks are the only source of truth for money coming in**, verified against the raw request
  body and deduplicated, so a replayed or forged webhook does nothing.

## Built with

Next.js 16, TypeScript, Postgres (PGlite locally), Drizzle, Tailwind, Vitest. The onchain
version adds Base, Safe, USDC and Coinbase Smart Wallet.

More detail for anyone working on the code: [AGENTS.md](./AGENTS.md) (rules and gotchas) and
[HANDOFF.md](./HANDOFF.md) (what was built, phase by phase).
