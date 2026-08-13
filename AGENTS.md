<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# JFK

A private group treasury for friends — Nigerian Ajo/Esusu, digitized. See
[BLUEPRINT.md](./BLUEPRINT.md) for the full product and architecture plan. It is
the source of truth; this file only covers how to work in the repo.

## Getting started

```bash
pnpm install
cp .env.example .env.local     # defaults work as-is for local dev
pnpm db:migrate
pnpm dev
```

No database to install or start. `DATABASE_URL=file:./.data/jfk` runs **PGlite**
— real Postgres compiled to WASM, in-process. Production points the same
variable at a `postgresql://` server and `src/lib/db` switches drivers.

> **PGlite is single-process.** Only one thing may hold `.data/` at a time, so
> stop `pnpm dev` before running `db:migrate`, `db:reset` or `db:seed`. Running
> both gives an out-of-memory crash rather than a clear error. This restriction
> disappears the moment `DATABASE_URL` points at a real server.

With no `RESEND_API_KEY`, sign-in codes print to the dev terminal and are shown
on the sign-in screen. Nothing is emailed.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm test` | Vitest — unit + DB-backed |
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm build` | Production build |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:reset` | Delete local data and re-migrate |
| `pnpm db:seed` | Two realistic groups, four users, printed session cookies |
| `pnpm webhook:replay <ref>` | Deliver a signed Paystack webhook to the running dev server, twice, plus a forged one |
| `pnpm simulate` | Run contributions through the whole payment pipeline with no Paystack account (dev only) |
| `pnpm jobs list|tick|run <name>` | Scheduled jobs; `--at 2026-09-02` fast-forwards the clock |

## Rules that are not negotiable

These exist because this app moves real money between real friends.

1. **Money is `Money`** (`src/lib/money.ts`) — integer kobo in a `bigint`.
   Never a float, never a `number` for an amount. Division must state where the
   remainder went (`split`), and amounts of different currencies never combine.
2. **Balances are derived, never stored as a mutable field.** They come from
   summing ledger entries. `account_balances` is only a cache, which the
   nightly reconciliation re-derives and alarms on if it has drifted.
3. **Only `modules/ledger` may write to `ledger_*` tables.** Everything else
   calls `operations.ts`, which names movements in domain terms ("a
   contribution happened"), never in debits and credits. Postgres enforces
   the rest: entries are append-only, every transaction must balance at
   COMMIT, and no group account may go negative.
4. **No fund release without an approved proposal** — enforced by a `NOT NULL`
   foreign key, not by a code check.
5. **`audit_logs` is append-only** — enforced by a Postgres trigger
   (`0001_audit_logs_append_only.sql`), so it holds regardless of which role
   connects. Corrections are new rows.
6. **Webhooks are the source of truth for money in**, never the API response.
   Starting a charge writes a `payments` row and nothing else; only a verified,
   deduplicated event posts to the ledger. Signature verification runs on the
   **raw request body** — parsing and re-serialising changes the whitespace and
   invalidates the HMAC.
7. **Fees**: `modules/payments/fees.ts` is the only place Paystack's pricing
   appears. Gross-up is the default, so the treasury receives round numbers and
   the member's card carries the awkward kobo.
8. **Authorization lives at the data layer**, via `requireUser()` and (from
   Phase 1) a `can()` policy module. Layout redirects are convenience, not
   security.

## Conventions

- **Modules** (`src/modules/*`) own their tables and expose a `service.ts`.
  Modules call services, never another module's tables.
- **Results over exceptions** for expected failures: services return typed
  unions (`{ ok: false, reason: ... }`) so callers must handle them.
- **Zod at every boundary** — server actions validate their own input.
- Secrets are read through `env()` (`src/lib/env.ts`), which validates once at
  first use and fails loudly.

## Next.js 16 gotchas that bit us

- `cookies()` and `headers()` are **async**.
- `middleware.ts` is deprecated — the convention is **`proxy.ts`**.
- A `"use server"` file may **only export async functions**. Exporting a
  constant from one makes every action in that file fail at call time while the
  page still renders fine. Non-function exports live in a sibling module
  (see `sign-in/state.ts`).
- Do not open database connections at module load: `next build` imports every
  module to collect page data. `src/lib/db` is lazy behind a proxy for this
  reason.
- `LayoutProps<"/">` and `PageProps<"/groups/[groupId]">` are generated types —
  run `next typegen` before `tsc` on a clean checkout.
- Packages that touch the filesystem or native addons must be listed in
  `serverExternalPackages` (see `next.config.ts`). Bundling PGlite breaks its
  Node built-in usage with a confusing
  `ERR_INVALID_ARG_TYPE: Received an instance of URL`.
- Standalone scripts that import server modules need the `react-server` export
  condition, or `server-only` throws:
  `node --conditions=react-server --import tsx scripts/x.mts`.
- When asserting on SSR HTML, remember React separates adjacent text nodes with
  `<!-- -->`. `payout #1` renders as `payout #<!-- -->1`.

## Testing

`src/lib/db/testing.ts` gives any test a real, migrated, in-memory Postgres:

```ts
const t = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
```

This is how the financial invariants get tested for real rather than mocked.
Test files run **sequentially** (`fileParallelism: false`) — each WASM Postgres
is memory-hungry and parallel suites exhaust the heap.
