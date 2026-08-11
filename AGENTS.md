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

## Rules that are not negotiable

These exist because this app moves real money between real friends.

1. **Money is `Money`** (`src/lib/money.ts`) — integer kobo in a `bigint`.
   Never a float, never a `number` for an amount. Division must state where the
   remainder went (`split`), and amounts of different currencies never combine.
2. **Balances are derived, never stored as a mutable field.** They come from
   summing ledger entries. (Ledger lands in Phase 2.)
3. **Only `modules/ledger` may write to `ledger_*` tables.**
4. **No fund release without an approved proposal** — enforced by a `NOT NULL`
   foreign key, not by a code check.
5. **`audit_logs` is append-only** — enforced by a Postgres trigger
   (`0001_audit_logs_append_only.sql`), so it holds regardless of which role
   connects. Corrections are new rows.
6. **Webhooks are the source of truth for money in**, never the API response.
   Every provider event is deduplicated on a unique index.
7. **Authorization lives at the data layer**, via `requireUser()` and (from
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
- `LayoutProps<"/">` and friends are generated types — run `next typegen`
  before `tsc` on a clean checkout.

## Testing

`src/lib/db/testing.ts` gives any test a real, migrated, in-memory Postgres:

```ts
const t = await createTestDb();
vi.mock("@/lib/db", async () => ({ db: t.db }));
```

This is how the financial invariants get tested for real rather than mocked.
Test files run **sequentially** (`fileParallelism: false`) — each WASM Postgres
is memory-hungry and parallel suites exhaust the heap.
