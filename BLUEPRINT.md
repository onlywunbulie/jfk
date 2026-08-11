# JFK — Build Plan

## Context

JFK digitizes the Nigerian **Ajo/Esusu** contribution culture for a private circle of friends: a group pools money on a schedule, the money is locked, and it only leaves the pool when the group's own governance rules say so. The guiding principle is **nobody can unilaterally take group money — not even an admin.**

This is a friends-only prototype first. The plan below is deliberately a **modular monolith**, not a startup-sized system. The one place it does *not* cut corners is the financial core: a double-entry ledger, idempotent payment handling, and explicit state machines. Those are the parts that are expensive to retrofit and catastrophic to get wrong.

**Decisions confirmed with the user before planning:**

| Decision | Choice |
|---|---|
| Custody | Paystack merchant balance + internal ledger; payouts via Transfers API |
| Payout model | **Both** pooled treasury *and* rotating (esusu) groups in MVP |
| Stack | Next.js + TypeScript full-stack, Postgres |
| Platform | Mobile-first responsive web / PWA |

> ⚠️ **Read the Risks section before writing code.** Custody choice #1 means real money from your friends settles into a bank account in *your* name. That is a relationship and legal exposure, not a technical one, and no amount of good architecture removes it.

---

## 1. Product Summary

**JFK is a private group treasury for friends.** Each group agrees on a contribution amount and cadence, contributions are auto-collected from members' saved cards, funds sit locked in a group wallet, and money only moves out when a proposal clears the group's approval threshold. Every naira is traceable to a ledger entry.

Three things must feel excellent or the product fails:
1. **Contributing is effortless** — set it once, it happens.
2. **The money is visibly safe** — balances, locks, and history are always legible.
3. **Deciding together feels good** — proposals and voting are fast and social, not bureaucratic.

Two group archetypes, sharing one engine:

- **Treasury group** (`TREASURY`) — money accumulates, stays locked, leaves only by proposal + vote. *This is JFK Empire.*
- **Rotating group** (`ROTATING`) — classic Ajo. Each cycle the full pot pays out to one member in a fixed order. Governance covers order changes and default handling, not each payout.

---

## 2. Core User Flows

**F1 — Onboard.** Invite link → email OTP sign-in → set display name + avatar → set 6-digit transaction PIN → land in group.

**F2 — Create group.** Name → type (Treasury/Rotating) → contribution amount + cadence + start date → lock rule (Treasury) or payout order (Rotating) → governance thresholds (defaults pre-filled) → invite members.

**F3 — Join.** Open invite → preview group (name, members, amount, cadence, rules) → accept → add card → first contribution scheduled.

**F4 — Add payment method.** Paystack inline charge of ₦50 to tokenize → refunded → `authorization_code` stored → card shown as `•••• 4321 · GTB · exp 09/28`.

**F5 — Auto contribution.** Cycle opens → T-3d reminder → due date: charge saved authorization → webhook confirms → ledger posts → group balance updates → activity feed + notification. On failure: retry ladder, then mark member in arrears.

**F6 — Manual contribution.** Member taps "Pay now" → Paystack checkout → same webhook path as F5.

**F7 — Propose a spend.** Admin: amount + title + reason + destination (bank account, resolved and name-verified) + voting deadline → proposal broadcast to group → members vote Yes/No/Abstain → threshold met → status `APPROVED` → **second step:** an admin taps "Execute", enters PIN → Paystack transfer → webhook confirms → ledger posts → receipt in feed.

**F8 — Rotating payout.** Cycle closes with all contributions collected → next member in order becomes the beneficiary → payout auto-proposes at the group's `ROTATION_PAYOUT` threshold (default: auto-approve if cycle is fully funded) → transfer executes → order advances.

**F9 — Group life.** Chat, activity feed, members list, settings. Rule changes and member removals go through governance, not admin fiat.

---

## 3. Feature Map

```
JFK
├── Identity        auth, profile, PIN, sessions, devices
├── Groups          create, invite, membership, roles, settings, dissolution
├── Contributions   schedules, cycles, obligations, arrears, reminders
├── Money           ledger, wallets, locks, payments in, payouts out, reconciliation
├── Governance      proposals, votes, thresholds, execution
├── Social          chat, reactions, mentions, activity feed
├── Notifications   in-app, web push, email (transactional only)
└── Ops             audit log, admin console, webhook inspector
```

---

## 4. MVP vs Later

### MVP — build these

| Area | Scope |
|---|---|
| Auth | Email OTP (magic code), session cookies, transaction PIN for money actions |
| Groups | Create, invite link, join, member list, admin roles, both group types |
| Contributions | Fixed amount, monthly/weekly cadence, cycles, obligation tracking, arrears flag |
| Payments in | Paystack card tokenization + recurring charge, webhooks, retry ladder |
| Ledger | Double-entry, derived balances, available vs locked, full transaction history |
| Locks | Date-based and cycle-count-based lock rules |
| Governance | Proposals, Yes/No/Abstain, per-action thresholds, deadlines, execution gate |
| Payouts | Paystack Transfers to a resolved bank account, two-step execute, rotation payouts |
| Chat | Text messages, replies, reactions, mentions, system messages |
| Activity feed | Financial + governance + membership events |
| Notifications | In-app bell + web push for the 8 essential types (§16) |
| Audit log | Append-only record of every privileged and financial action |
| Multi-group | Home overview across groups |
| Personal wallet | Balance, payment methods, personal history, memberships |

### Later — v1.1 to v2

Bank-transfer contributions via dedicated virtual accounts · contribution penalties & grace periods · member reputation/reliability score · group goals & savings targets · exportable statements (CSV/PDF) · receipts as shareable images · polls · group documents · emergency withdrawal with elevated threshold · treasury categories/envelopes · financial analytics · scheduled payouts · crypto rail (§11) · native mobile app · group discovery.

### Probably unnecessary

Contribution streaks (gamification noise for adults moving real money) · member leaderboards (creates social friction in a money group) · referral system (invite-only by design) · public groups (contradicts the product) · weighted/token governance (see §9) · smart contracts (see §11) · group investments (a whole other regulated product).

---

## 5. Information Architecture

Five tabs, mobile-first, Phantom-inspired: dark ground, one accent, generous spacing, cards over chrome, numbers as the hero.

```
🏠 Home            Total across groups · group cards (balance, next payment, status
                   chips) · action-needed strip · recent activity
👥 Group           ├── Wallet      balance, available/locked split, contribute CTA, tx list
   (tab bar        ├── Chat        messages, system events inline
    inside)        ├── Proposals   active (with live vote bars) / past
                   ├── Members     roles, contribution reliability
                   └── Settings    rules, governance, locks, danger zone
➕ Action          contextual: contribute · propose · invite
🔔 Activity        notifications + cross-group feed
👤 Wallet          personal balance, payment methods, history, groups, profile
```

**Key components:** BalanceCard (large number, available/locked pill) · GroupCard · TransactionRow (icon + counterparty + signed amount + status dot) · ProposalCard (progress bar toward threshold, quorum, countdown) · VoteSheet · ContributionStatusGrid (10 avatars, paid/pending/failed) · LockBadge · ChatBubble · SystemEventChip · AmountInput (naira-formatted) · PinPad · EmptyState.

**States every screen must handle:** loading (skeleton, never spinner-on-blank) · empty · error with retry · **pending/optimistic** (money in flight is its own visual state — amber, animated) · failed with reason and next action · offline.

---

## 6. Roles & Permissions

Three roles: **Owner** (creator, exactly one, cannot leave without transferring), **Admin**, **Member**.

| Action | Member | Admin | Owner | Also needs |
|---|:--:|:--:|:--:|---|
| View wallet, history, proposals | ✅ | ✅ | ✅ | |
| Contribute, chat, vote | ✅ | ✅ | ✅ | |
| Create proposal | ⚙️ | ✅ | ✅ | ⚙️ = group setting, default **on** |
| Invite / remove member | ❌ | ✅ | ✅ | removal ≥3 members → proposal |
| Edit non-financial settings (name, avatar) | ❌ | ✅ | ✅ | |
| Change contribution amount / cadence | ❌ | ❌ | ❌ | **proposal @ 66.7%** |
| Change governance thresholds | ❌ | ❌ | ❌ | **proposal @ 75%** |
| Release funds | ❌ | initiate only | initiate only | **proposal @ threshold** |
| Grant / revoke admin | ❌ | ❌ | ✅ | revoke admin → **proposal @ 75%** |
| Dissolve group | ❌ | ❌ | ❌ | **proposal @ 80%** |
| Execute an approved proposal | ❌ | ✅ | ✅ | + PIN + proposal `APPROVED` |

**The hard rule, enforced in one place:** *no code path debits a group's treasury without an `approved_proposal_id`.* This is a database constraint on the release table, not a convention — see §8.

---

## 7. Database Schema

Postgres. All money is **`BIGINT` in kobo**. Never floats, never decimals-as-strings. All IDs are UUIDv7 (sortable). All tables get `created_at`; mutable ones get `updated_at`.

### Identity
```
users              id, email(uniq), phone, display_name, avatar_url, pin_hash,
                   email_verified_at, created_at
sessions           id, user_id, token_hash, ip, user_agent, expires_at, revoked_at
payment_methods    id, user_id, provider, provider_auth_code, last4, brand, bank,
                   exp_month, exp_year, is_default, status(ACTIVE|EXPIRED|REVOKED),
                   signature(uniq per user — Paystack dedupe)
bank_accounts      id, owner_type(USER|GROUP), owner_id, bank_code, account_number,
                   resolved_name, provider_recipient_code, verified_at
```

### Groups
```
groups             id, name, avatar_url, type(TREASURY|ROTATING), currency,
                   owner_id, status(ACTIVE|DISSOLVING|DISSOLVED), created_at
group_members      id, group_id, user_id, role(OWNER|ADMIN|MEMBER),
                   status(INVITED|ACTIVE|LEFT|REMOVED), joined_at, exited_at,
                   rotation_position (nullable)
                   UNIQUE(group_id, user_id)
group_invites      id, group_id, code(uniq), created_by, email(null=open link),
                   max_uses, uses, expires_at, revoked_at
group_settings     group_id PK, contribution_amount, cadence(WEEKLY|MONTHLY),
                   due_day, grace_days, members_can_propose, default_vote_days,
                   quorum_pct, auto_charge_enabled
governance_rules   id, group_id, action(enum), threshold_pct, min_voters
                   UNIQUE(group_id, action)
```

### Contributions
```
contribution_cycles   id, group_id, sequence_no, period_start, period_end, due_at,
                      status(SCHEDULED|OPEN|CLOSED|SETTLED), expected_total,
                      collected_total, beneficiary_member_id (ROTATING only)
                      UNIQUE(group_id, sequence_no)
contributions         id, cycle_id, group_id, member_id, amount, status,
                      payment_id, attempt_count, next_retry_at, paid_at
                      UNIQUE(cycle_id, member_id)   ← duplicate-charge guard
```
`contributions.status`: `PENDING → PROCESSING → PAID` | `FAILED` | `WAIVED` | `MISSED`

### Money — the core
```
ledger_accounts    id, owner_type(USER|GROUP|SYSTEM), owner_id, currency,
                   purpose(USER_WALLET | GROUP_AVAILABLE | GROUP_LOCKED |
                           PSP_SETTLEMENT | FEES | SUSPENSE | EXTERNAL)
                   UNIQUE(owner_type, owner_id, purpose, currency)

ledger_transactions id, type, group_id, idempotency_key(uniq), description,
                    metadata jsonb, occurred_at, created_at
                    -- immutable. corrections are reversing transactions.

ledger_entries     id, transaction_id, account_id, direction(DEBIT|CREDIT),
                   amount BIGINT CHECK(amount > 0), created_at
                   INDEX(account_id, created_at)
                   -- INVARIANT: per transaction_id, Σdebits = Σcredits

payments           id, provider, provider_ref(uniq), direction(IN|OUT), amount, fee,
                   status(INITIATED|PENDING|SUCCESS|FAILED|REVERSED),
                   user_id, group_id, purpose, payment_method_id,
                   bank_account_id, ledger_transaction_id, raw jsonb
webhook_events     id, provider, provider_event_id(uniq), event_type, payload jsonb,
                   signature_valid, processed_at, error
                   -- UNIQUE(provider, provider_event_id) ← webhook dedupe
```

### Locks, governance, release
```
fund_locks         id, group_id, amount(null = all), rule_type(DATE|CYCLE_COUNT|MANUAL),
                   unlock_at, unlock_after_cycle, status(LOCKED|ELIGIBLE|RELEASED|CANCELLED),
                   created_by, created_via_proposal_id

proposals          id, group_id, created_by, action(enum), title, reason,
                   amount, destination_bank_account_id, payload jsonb,
                   threshold_pct_snapshot, quorum_snapshot, eligible_voter_count,
                   status, opens_at, closes_at, decided_at, executed_at
votes              id, proposal_id, member_id, choice(YES|NO|ABSTAIN), reason,
                   cast_at   UNIQUE(proposal_id, member_id)

fund_releases      id, group_id, proposal_id NOT NULL UNIQUE, amount,
                   destination_bank_account_id, status, payment_id,
                   executed_by, executed_at, failure_reason
                   -- proposal_id NOT NULL is the constitutional guarantee
```
`proposals.status`: `DRAFT → OPEN → (APPROVED | REJECTED | EXPIRED | CANCELLED)`, then `APPROVED → EXECUTING → (EXECUTED | EXECUTION_FAILED)`

### Social & ops
```
messages           id, group_id, sender_id(null=system), body, reply_to_id,
                   kind(TEXT|SYSTEM|ANNOUNCEMENT), metadata jsonb, edited_at, deleted_at
reactions          id, message_id, user_id, emoji  UNIQUE(message_id,user_id,emoji)
mentions           id, message_id, user_id
activity_events    id, group_id, actor_id, type, subject_type, subject_id,
                   payload jsonb, created_at
notifications      id, user_id, group_id, type, title, body, link,
                   read_at, delivered_channels[]
push_subscriptions id, user_id, endpoint, keys jsonb
audit_logs         id, actor_id, actor_ip, group_id, action, subject_type,
                   subject_id, before jsonb, after jsonb, created_at
                   -- append-only; no UPDATE/DELETE grant
job_runs           id, job_key(uniq), status, attempts, last_error, run_at
```

**Relationship spine:** `users ─< group_members >─ groups ─< contribution_cycles ─< contributions`; every money movement produces exactly one `ledger_transactions` with ≥2 balanced `ledger_entries`; `fund_releases` always points at an approved `proposals` row.

---

## 8. Financial / Transaction Architecture

### Principle: balances are derived, never stored as a mutable field

```
balance(account) = Σ(credits) − Σ(debits)
```

Computed from `ledger_entries`. For speed, keep a **`account_balances` cache table** updated inside the same transaction that writes the entries, plus a nightly job that recomputes from entries and alarms on any drift. The cache is an optimization; the entries are the truth.

**Group available vs locked** are two distinct ledger accounts (`GROUP_AVAILABLE`, `GROUP_LOCKED`). Locking money is itself a ledger transaction moving value between them — so the lock is auditable, not a flag.

### The full path: Payment → Contribution → Balance → Lock → Proposal → Vote → Release

**1. Payment in.**
Charge the saved authorization → Paystack returns pending → `payments` row created `INITIATED`. Nothing is credited yet. **The webhook is the only source of truth for money in.**

**2. Webhook received.**
Verify `x-paystack-signature` (HMAC-SHA512 of raw body with secret key) → insert into `webhook_events`; a unique-violation on `provider_event_id` means *already seen* → 200 OK, stop. This single unique index kills the duplicate-webhook class of bugs.

**3. Contribution recorded.**
In one DB transaction, keyed by `idempotency_key = "contribution:{contribution_id}"`:
```
DR  PSP_SETTLEMENT      ₦50,000     (money is in the Paystack balance)
CR  GROUP_AVAILABLE     ₦49,250
CR  FEES                     ₦750     (Paystack's cut, recorded not hidden)
```
`contributions.status = PAID`, cycle `collected_total` bumped, activity event + notification emitted.

> **Fee policy decision:** the group absorbs the gateway fee by default, so ₦50,000 charged credits ₦49,250 to the treasury. Alternative — gross up the charge so the treasury receives a clean ₦50,000 and the member pays ₦50,762. Recommend **gross-up** for round-number sanity in an Ajo context; make it a group setting.

**4. Lock.**
When the group's lock rule applies:
```
DR  GROUP_AVAILABLE  →  CR  GROUP_LOCKED
```
Available balance drops; total is unchanged. A `fund_locks` row records the rule.

**5. Unlock.** A scheduled job flips `fund_locks.status` to `ELIGIBLE` when the date/cycle condition is met, and posts the reverse entry. **Eligible ≠ withdrawn** — it just means a release proposal is now permitted.

**6. Proposal & vote.** No money moves. The proposal *snapshots* `threshold_pct` and `eligible_voter_count` at open time so later membership changes cannot retroactively flip the outcome.

**7. Approval.** When `yes / (yes + no) ≥ threshold` **and** `(yes+no+abstain) ≥ quorum`, status → `APPROVED`. Evaluated on each vote *and* at deadline. On approval, immediately place a **reservation**:
```
DR  GROUP_AVAILABLE  →  CR  GROUP_LOCKED   (tagged reserved:proposal_id)
```
so two concurrent approved proposals cannot both spend the same naira.

**8. Execution.** Admin + PIN → `fund_releases` created → Paystack Transfer initiated with an idempotency reference → status `EXECUTING`. The transfer webhook decides the outcome:
```
transfer.success →  DR GROUP_LOCKED(reserved) ₦300,000
                    CR EXTERNAL               ₦300,000   → EXECUTED
transfer.failed  →  reverse the reservation back to GROUP_AVAILABLE → EXECUTION_FAILED
                    (funds are safe; a new proposal or a retry is required)
```

**9. Rotating payout.** Same machinery: cycle closes fully funded → payout release created against an auto-approved `ROTATION_PAYOUT` proposal → transfer to the beneficiary's verified bank account → `rotation_position` advances.

### Non-negotiable invariants (enforce as constraints + tested assertions)
1. Every `ledger_transaction` balances to zero.
2. `ledger_entries` and `ledger_transactions` are never UPDATEd or DELETEd — corrections are reversing entries.
3. No `fund_release` without an `APPROVED` proposal (`NOT NULL` FK).
4. `GROUP_AVAILABLE` balance can never go negative (checked in the posting function).
5. One contribution per member per cycle (`UNIQUE`).
6. One processed webhook per provider event (`UNIQUE`).
7. Sum of all account balances across the system = 0 (double-entry closure) — asserted nightly.

---

## 9. Governance Architecture

**One member, one vote.** Recommended firmly for the private version: weighting by contribution creates a "rich member controls the group" dynamic that poisons a friendship circle, and it invites gaming. Contribution history is surfaced socially (reliability on the members list) rather than mechanically as voting power. Weighted voting can be added later as a group-level option.

**Approval math.** `approval = yes / (yes + no)`. Abstain counts toward **quorum** but not the ratio — this is the fair reading: abstainers showed up but declined to take a side. Default quorum: **60% of eligible voters must respond.**

**Recommended defaults** (all editable, editing them itself requires 75%):

| Action | Threshold | Notes |
|---|---:|---|
| `FUND_RELEASE_SMALL` (≤20% of treasury) | 50% | routine spends |
| `FUND_RELEASE_LARGE` (>20%) | 66.7% | the JFK Empire example |
| `CHANGE_CONTRIBUTION` | 66.7% | amount or cadence |
| `CHANGE_GOVERNANCE` | 75% | thresholds themselves |
| `REMOVE_MEMBER` | 66.7% | required at ≥3 members |
| `REMOVE_ADMIN` | 75% | |
| `CHANGE_LOCK_RULE` | 75% | shortening a lock is a big deal |
| `ROTATION_ORDER_CHANGE` | 66.7% | |
| `DISSOLVE_GROUP` | 80% | |
| `EMERGENCY_WITHDRAWAL` | 80% | *later* |

**Eligible voters** = `ACTIVE` members at proposal open, snapshotted. A member who leaves mid-vote has their vote voided and the denominator reduced; a member who joins mid-vote is not eligible.

**Ties.** With a threshold >50% a tie simply fails to reach it → `REJECTED`. At exactly 50% threshold, define `≥` as passing, and state it in the UI ("50% or more approves"). No coin flips, no admin tiebreak.

**Deadlines.** Default 72 hours. A job closes expired proposals; late votes are rejected at write time by a `closes_at` check inside the transaction.

**Proposal lifecycle is append-only** — every state change writes an `activity_event` and an `audit_log` row, so the group can always reconstruct "who proposed, who voted, when, and what happened."

---

## 10. Payment Architecture

### Provider recommendation: **Paystack**

| | Paystack | Flutterwave | Monnify |
|---|---|---|---|
| Reliability | Strongest NG uptime reputation | Good, broader Africa | Good, Moniepoint-backed |
| Dev experience | **Best-in-class docs, clean API** | Good, larger surface area | Decent, thinner docs |
| Recurring | `authorization_code` reuse, mature | Tokenized cards | Card + direct debit |
| Webhooks | HMAC-SHA512, well documented | Supported | Supported |
| Payouts | Transfers API + Resolve Account | Supported | Supported |
| Virtual accounts | Available | Available | **Cheapest / best** |
| Local fee | 1.5% + ₦100, ₦100 waived under ₦2,500, **capped ₦2,000** | Comparable | Competitive on transfers |

**Choose Paystack** for the MVP: developer experience and documentation quality dominate for a solo build, the fee cap of ₦2,000 makes ₦50,000 contributions cost a flat ~₦850, and it does all four things we need (tokenize, recur, webhook, payout) in one account. **Revisit Monnify in v1.1** for dedicated virtual accounts, because in Nigeria bank transfer often beats cards on both success rate and cost — the `PaymentProvider` interface below makes that a swap, not a rewrite.

### Mechanics
- **Tokenize:** first charge (₦50, refunded) via Paystack Popup → `charge.success` webhook carries `authorization.authorization_code` + `signature`. Store the code, never the PAN. Dedupe cards on `signature`.
- **Recur:** `POST /transaction/charge_authorization` with `{authorization_code, email, amount, reference}`. **Our `reference` is deterministic** — `jfk_c_{contribution_id}` — so a retried request cannot double-charge.
- **Payout:** `POST /transferrecipient` (once per bank account, after `GET /bank/resolve` name verification shown to the group) → `POST /transfer` with a deterministic reference. **Disable OTP-per-transfer** in the Paystack dashboard so releases can execute programmatically; the human gate is our PIN + governance, not an SMS.
- **Never trust the API response for finality.** `charge_authorization` returning success still gets confirmed by webhook before the ledger posts. One code path in, one out.

### Retry ladder for failed contributions
`T+0 fail → retry at +6h → +24h → +72h → give up`. Only retry on *soft* declines (insufficient funds, timeout, issuer decline). Hard failures (card expired, revoked, invalid) mark the method `EXPIRED` and notify the member to re-add a card — retrying those is pure noise. After the ladder, `contributions.status = MISSED` and the member shows in arrears.

### Provider abstraction (this is the seam that matters)
```ts
interface PaymentProvider {
  tokenize(user, ctx): Promise<PaymentMethodToken>
  charge(token, amountMinor, ref, meta): Promise<ChargeResult>
  resolveBankAccount(bankCode, accountNumber): Promise<{name}>
  createPayoutRecipient(bankAccount): Promise<RecipientRef>
  payout(recipient, amountMinor, ref): Promise<PayoutResult>
  verifyWebhook(rawBody, headers): WebhookVerification
  parseWebhook(payload): NormalizedPaymentEvent
}
```
Everything above the ledger speaks `NormalizedPaymentEvent`. Paystack, Monnify, and a future crypto rail are all implementations.

---

## 11. Crypto Strategy

**Recommendation: not in the MVP. Design the seam, ship fiat.**

Why not now: your friends contribute in naira from Nigerian bank cards. A crypto rail adds key custody (the single hardest problem in the product), on/off-ramp friction, price volatility on a savings product, tax/regulatory ambiguity, and an entirely second reconciliation surface — for zero MVP user value. None of it makes the first version more usable.

Why the architecture is already ready: the ledger is currency-and-rail agnostic. `ledger_accounts` carries `currency`; `payments` carries `provider`. A USDC rail is a new `PaymentProvider` implementation plus a `crypto_addresses` table — the contribution, lock, proposal, vote, and release logic are untouched.

**When you do add it (v2), in this order:**
1. **Stablecoin deposits only** (USDC on Base or Solana — cheap, fast finality). Read-only: watch a deposit address, credit the ledger on N confirmations. Low risk, immediately useful for diaspora members.
2. **Crypto withdrawals** via a custodial partner or exchange API — do not roll your own hot wallet.
3. **Group multisig** (Safe on Base, or Squads on Solana) *only if* the group genuinely wants on-chain custody. Then JFK's voting becomes a UI over multisig signers.

**Do not write smart contracts.** Your governance rules already live in a database that ten friends trust. A contract adds audit cost, immutability of bugs, and gas — and buys trustlessness that a group of homeboys does not need. If the day comes that JFK is public and strangers must trust the treasury, revisit — and even then, use battle-tested Safe rather than bespoke Solidity.

---

## 12. Backend Architecture

**Modular monolith** inside one Next.js app. Correct at this size — microservices would add network failure modes and distributed-transaction problems to a system whose hardest requirement is *transactional consistency*.

```
src/
  app/                 routes (App Router) + route handlers
  modules/
    identity/          auth, users, sessions, PIN
    groups/            membership, roles, invites, settings
    contributions/     schedules, cycles, obligations
    ledger/            ⭐ accounts, entries, posting, balances  ← no other module writes here
    payments/          provider adapters, webhooks, retries
    governance/        proposals, votes, thresholds
    releases/          execution state machine
    social/            chat, reactions, activity
    notifications/     dispatch, channels, preferences
    audit/             append-only logging
  lib/                 db, money, auth, validation, realtime, jobs
```

**Module rules that keep this clean enough to split later:**
- Each module exposes a `service.ts`; modules call services, never each other's tables.
- **Only `ledger/` may INSERT into `ledger_*`.** Enforce with a lint rule and a DB role if you want teeth.
- Cross-module reactions go through a small in-process event bus (`contribution.paid`, `proposal.approved`) so notifications and activity feed don't tangle into payment code.
- Money type: a `Money` value object over `bigint` kobo. Forbid raw arithmetic on amounts.

**Auth:** Auth.js v5, email OTP (6-digit code, 10-min TTL, rate-limited). No passwords to leak. Sessions are httpOnly, secure, sameSite=lax, 30-day rolling, revocable from the profile page. **Transaction PIN** (Argon2id-hashed, 5 attempts then 15-min lockout) required for: adding/removing a payment method, executing a release, changing bank details. Passkeys are a good v1.1 upgrade.

**Authorization:** a single `can(user, action, resource)` policy module derived from §6, called in *every* server action. Never scatter role checks through UI code. Pair it with row-level scoping — every group query filters by an `ACTIVE` membership.

---

## 13. API Structure

Server Actions for the app's own UI (typed end-to-end, no hand-written client), REST route handlers only where an external caller exists.

```
POST /api/webhooks/paystack        signature-verified, always 200, queue for processing
POST /api/cron/*                   secret-header-protected job triggers
GET  /api/health                   db + provider reachability
```

Server action surface, by module:
```
identity     requestOtp, verifyOtp, updateProfile, setPin, revokeSession
groups       createGroup, updateSettings, createInvite, acceptInvite,
             changeRole, removeMember, leaveGroup
payments     initTokenization, listMethods, setDefaultMethod, removeMethod,
             addBankAccount(→resolve+verify)
contribs     getCycle, contributeNow, toggleAutoPay, listContributions
ledger       getGroupBalance, listTransactions, getStatement
governance   createProposal, castVote, cancelProposal, listProposals
releases     executeRelease(proposalId, pin), retryRelease
social       sendMessage, react, editMessage, deleteMessage, listMessages
notifs       list, markRead, updatePreferences, registerPush
```

Conventions: Zod schema at every boundary · every mutation takes an idempotency key for money paths · errors are typed discriminated unions, never thrown strings · every money mutation writes an audit row in the same DB transaction.

---

## 14. Realtime Architecture

Needed for chat, live vote counts, and contribution-status changes. Options:

| Option | Verdict |
|---|---|
| Polling (5–10s) | Fine for 10 users; ugly for chat |
| SSE from a route handler | Works, but serverless connection limits get awkward |
| **Managed WebSockets (Pusher/Ably)** | **Recommended** — free tier covers a friend group many times over, no infra, ~1hr integration |
| Self-hosted Socket.io | Needs a long-lived host; more ops than this project deserves |

**Recommend Pusher Channels** (or Ably — equivalent). Private per-group channels authorized by a server endpoint that checks membership. Server publishes on `message.created`, `vote.cast`, `proposal.status_changed`, `contribution.paid`. **The client never trusts a realtime payload for money** — it uses the event as a cue to revalidate from the server. That keeps realtime a UX layer, not a correctness dependency, and lets you swap providers freely.

---

## 15. Background Jobs

**Recommend Inngest** over raw Vercel Cron: durable steps, automatic retries with backoff, built-in idempotency keys, and a UI to inspect failures — all of which you *will* need on the payment retry ladder, and all of which you'd otherwise hand-roll. Free tier is ample. (Alternative if you self-host: `pg-boss` on Postgres — no new vendor, but you build the observability.)

| Job | Schedule | Does |
|---|---|---|
| `open-cycles` | daily 00:05 WAT | Create the next `contribution_cycle` + `contributions` rows per group |
| `send-due-reminders` | daily 09:00 | T-3d and T-0 notifications |
| `collect-contributions` | daily 09:15 | Charge saved authorizations for due, auto-pay-enabled contributions |
| `retry-failed-charges` | hourly | Walk the retry ladder for soft declines |
| `close-cycles` | daily 00:15 | Close ended cycles, mark `MISSED`, trigger rotation payout if funded |
| `evaluate-proposals` | every 15 min | Close expired proposals, finalize outcomes |
| `unlock-eligible-funds` | daily 00:20 | Flip satisfied `fund_locks` to `ELIGIBLE`, post reverse entries |
| `reconcile-ledger` | nightly 02:00 | Recompute balances from entries; assert §8 invariants; **alert on drift** |
| `sync-payment-status` | every 30 min | Poll Paystack for `payments` stuck `PENDING` >30 min (webhook safety net) |
| `expire-cards` | weekly | Flag cards expiring within 30 days, notify owners |

Every job is **idempotent and re-runnable** — keyed through `job_runs.job_key` (e.g. `collect:{cycle_id}:{date}`). Assume every job will run twice; make that harmless.

---

## 16. Security

| Threat | Mitigation |
|---|---|
| **Admin drains the treasury** *(the headline threat)* | `fund_releases.proposal_id NOT NULL` + threshold check inside the DB transaction + PIN at execution + destination account name-verified and shown to the group before voting |
| Forged webhook credits fake money | HMAC-SHA512 signature verification on the **raw** body before parsing; reject unsigned; allowlist Paystack IPs |
| Replayed webhook double-credits | `UNIQUE(provider, provider_event_id)` |
| Duplicate charge on retry | Deterministic `reference` per contribution + `UNIQUE(cycle_id, member_id)` |
| Account takeover → votes/spends | Email OTP + PIN gate on money actions + new-device notification + session revocation UI |
| **Compromised admin account** | Admin powers are already non-financial by design; add: any release notifies *all* members instantly, and any member can raise a `FREEZE_GROUP` flag that blocks execution pending review |
| OTP brute force / spam | Rate limit per email + per IP (Upstash Redis); 5 attempts then lockout |
| IDOR across groups | Every query scoped by verified `ACTIVE` membership; never trust a client-supplied `group_id` alone |
| Card data liability | Never touch a PAN — Paystack Popup + `authorization_code` only. Keeps you out of PCI scope |
| Secrets leakage | Env vars via Vercel/1Password, never committed; separate test/live keys; rotate on any suspicion |
| SQL injection / bad input | Parameterized queries via the ORM + Zod at every boundary |
| Silent tampering | Append-only `audit_logs`; DB user has no UPDATE/DELETE on ledger or audit tables |
| Money-in-flight lost | `payments` rows created *before* calling the provider; `sync-payment-status` reconciles anything orphaned |

**Essential MVP notifications** (the rest are v1.1 noise): contribution due · contribution successful · contribution failed · new proposal · proposal decided · fund released · added to group · mention.

---

## 17. Testing

Priority is inverted from a normal app: **the ledger gets the most tests and the UI gets the fewest.**

**Unit — must be exhaustive**
- `Money` arithmetic: rounding, fee splits, gross-up, no precision loss.
- Ledger posting: every transaction balances; negative-balance rejection; reversal correctness.
- Approval math: exact-threshold boundaries, abstain handling, quorum, tie behavior, snapshot immutability.
- Permission matrix: **table-driven test over every (role × action) cell in §6** — this catches the whole authorization class.
- Retry ladder classification: soft vs hard decline.

**Integration — against a real Postgres (Testcontainers)**
- Full contribution: charge → webhook → ledger → balance → feed.
- **Duplicate webhook delivered 3×** → exactly one contribution, one ledger transaction.
- Concurrent approved proposals racing for the same funds → second is rejected, no negative balance.
- Lock → eligible → proposal → vote → execute → transfer webhook → executed.
- Transfer fails → reservation reversed → balance restored exactly.
- Member joins mid-cycle, leaves mid-vote, is removed mid-cycle.
- Rotating cycle: underfunded → payout blocked; fully funded → payout to correct beneficiary; order advances.
- **Reconciliation property test:** generate N random valid operations, assert system-wide balance sum = 0 and derived == cached.

**E2E (Playwright) — a thin happy-path spine only**
Sign in → create group → invite → join → add card (Paystack test mode) → contribute → propose → vote to threshold → execute → verify balance and feed.

**Payment testing:** Paystack test keys with their documented test cards (success, insufficient funds, declined) + a local webhook fixture replayer so you can test failure paths without waiting on the network.

---

## 18. Recommended Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router) + TypeScript** | Confirmed; one deployable, server actions, great mobile web |
| DB | **Postgres (Neon)** | Transactions are non-negotiable for a ledger; branching DBs for testing |
| ORM | **Drizzle** | SQL-shaped, explicit transactions, no hidden queries — right instincts for financial code (Prisma is fine if you prefer it) |
| Auth | **Auth.js v5**, email OTP | No passwords; ~30 min to working |
| Styling | **Tailwind + shadcn/ui**, custom dark theme | Fast, and shadcn is a starting point you own, not a dependency you fight |
| Motion | **Framer Motion** | Delivers the Phantom-grade feel; used sparingly |
| Realtime | **Pusher Channels** | §14 |
| Jobs | **Inngest** | §15 |
| Payments | **Paystack** | §10 |
| Rate limit / cache | **Upstash Redis** | Serverless-native |
| Email | **Resend** + React Email | OTP + transactional |
| Push | Web Push (VAPID) | PWA notifications, no store needed |
| Errors | **Sentry** | You need to know when a charge fails at 9:15am |
| Validation | **Zod** | Shared client/server schemas |
| Testing | Vitest + Testcontainers + Playwright | §17 |

**PWA:** manifest + service worker + install prompt. Skip native until the friend group actually asks.

---

## 19. Deployment Architecture

```
Vercel (Next.js app + route handlers)
   ├── Neon Postgres          (prod branch + preview branches per PR)
   ├── Upstash Redis          (rate limits, OTP, short-lived locks)
   ├── Inngest Cloud          (scheduled + event-driven jobs)
   ├── Pusher                 (realtime channels)
   ├── Paystack               (webhooks → /api/webhooks/paystack)
   ├── Resend                 (email)
   └── Sentry                 (errors, alerts to your phone)
```

**Environments:** `local` (Docker Postgres + Paystack test keys + ngrok for webhooks) → `preview` (per-PR, Neon branch, test keys) → `production` (live keys, restricted).

**Ops discipline this project actually needs:**
- Neon PITR on; verify a restore once before real money lands.
- Migrations reviewed by hand — never auto-push schema to prod.
- Alerts on: reconciliation drift, webhook processing failures, payout failures, any negative-balance rejection.
- A tiny `/admin` page (your user ID only) showing recent webhooks, failed payments, and ledger drift. You will need this in week one.

---

## 20. Development Phases

Each phase ends with something demonstrable.

**Phase 0 — Foundation (3–4 days)**
Repo, Next.js + TS + Tailwind, Drizzle + Neon, Auth.js email OTP, design tokens and base components, deployed to Vercel. *Done when: you can sign in on your phone.*

**Phase 1 — Groups & Identity (4–5 days)**
Users, groups, members, roles, invite links, settings, the `can()` policy module + its full test table, Home and Group shells. *Done when: you and a friend are in JFK Empire together.*

**Phase 2 — The Ledger (5–6 days) ← do not rush this**
`ledger_accounts/transactions/entries`, the posting function, `Money`, derived + cached balances, reconciliation job, the full invariant test suite, transaction history UI seeded with fake data. *Done when: the property test passes and drift alarms work.*

**Phase 3 — Payments In (6–7 days)**
Paystack adapter, tokenization flow, `payment_methods`, webhook endpoint + dedupe, manual "Pay now" wired to the ledger. *Done when: a real ₦100 contribution from your own card lands correctly.*

**Phase 4 — Contributions & Automation (5–6 days)**
Schedules, cycles, obligations, Inngest jobs, retry ladder, arrears, contribution status grid, reminders. *Done when: a cycle collects from two members automatically.*

**Phase 5 — Locks & Governance (6–7 days)**
`fund_locks` + state machine, proposals, votes, threshold engine with snapshots, proposal UI with live vote bars, expiry job. *Done when: a proposal passes and reserves funds.*

**Phase 6 — Releases & Payouts (5–6 days)**
Bank account resolve + verify, Transfers adapter, `fund_releases` state machine, PIN gate, transfer webhooks, failure reversal, rotating-group payouts. *Done when: ₦100 leaves the treasury only via an approved proposal, and a forced failure reverses cleanly.*

**Phase 7 — Social & Notifications (5–6 days)**
Chat + reactions + mentions, activity feed, system events, in-app notifications, web push, PWA install. *Done when: the group feels alive.*

**Phase 8 — Polish & Hardening (5–7 days)**
Motion pass, empty/loading/error states everywhere, rate limiting, Sentry, admin console, E2E spine, seed script, reconciliation dry-run with real money. *Done when: you'd trust it with ₦500,000.*

**~7–9 weeks solo at a steady pace.** Phases 2, 3 and 6 carry the real risk — budget slack there, not in Phase 7.

---

## 21. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **You are personally the custodian.** Friends' money settles into your bank account under your name and BVN. | 🔴 Highest | Be explicit with the group *before* the first naira. Keep a dedicated bank account. Reconcile weekly. Understand that Nigerian regulation of pooled contribution schemes is not a solved question for an unlicensed operator — this is fine among ten friends, and stops being fine the moment it isn't. **Do not open this to strangers without proper structure.** |
| Ledger bug silently corrupts balances | 🔴 High | Phase 2 discipline; invariant tests; nightly reconciliation with alerting; append-only entries |
| Money leaves without approval | 🔴 High | `NOT NULL` FK constraint, not a code check; permission test table; PIN gate |
| Duplicate charges to friends' cards | 🟠 Med-High | Deterministic references, `UNIQUE(cycle_id, member_id)`, webhook dedupe — tested explicitly |
| Card success rates in Nigeria are mediocre | 🟠 Medium | Retry ladder + easy manual fallback; prioritize virtual accounts / bank transfer in v1.1 |
| Paystack account restricted or under review | 🟠 Medium | Provider abstraction from day one; keep a manual-record fallback path so the group isn't blocked |
| Social fallout — someone doesn't pay, votes go badly | 🟠 Medium | This is a product-design problem, not a bug. Make arrears visible but not humiliating; let the group set grace periods; never auto-shame |
| Scope creep from the "Later" list | 🟡 Med | The MVP checklist below is the contract |
| Solo-dev bus factor | 🟡 Med | PITR backups, a documented manual-payout runbook, and a monthly exported statement so the group's records survive the app |

---

## 22. Open Decisions

Settle these during the phase noted — none block starting Phase 0.

1. **Fee policy** — group absorbs vs member gross-up. *Recommend gross-up.* (Phase 3)
2. **Personal wallet: real balance or view-only?** MVP is simpler if the personal wallet is a *view* over your contributions and methods, with no user-held balance. A real user balance means refunds, top-ups, and withdrawals — a second money system. *Recommend view-only for MVP.* (Phase 2)
3. **What happens to a leaving member's contributed funds?** Forfeit / refund on dissolution / refund by proposal. *Recommend: refund requires a proposal at the `FUND_RELEASE_LARGE` threshold* — it's a payout like any other. Must be decided before Phase 5. (Phase 5)
4. **Rotating groups: what if the cycle underfunds?** Payout partial, delay, or cover from treasury. *Recommend delay + notify* for MVP. (Phase 4)
5. **Missed contributions: penalty or social pressure only?** *Recommend social-only for MVP*; penalties need an arrears sub-ledger. (Phase 4)
6. **Group dissolution mechanics** — proportional split by contribution vs equal split. Materially different math. (Phase 5, can defer to v1.1)
7. **Currency scope** — NGN only for MVP, but is any member abroad? Multi-currency touches the ledger's core, so decide before Phase 2. (Phase 2)
8. **Do you want a "freeze group" panic switch in MVP?** Cheap to add now, valuable if an account is compromised. (Phase 6)

---

## 23. Final MVP Checklist

**Ship when all of these are true.**

*Money*
- [ ] Double-entry ledger; balances derived from entries
- [ ] Group available and locked balances are separate ledger accounts
- [ ] Every movement has an immutable transaction + audit row
- [ ] Nightly reconciliation passes; drift alerts reach your phone
- [ ] System-wide balance sums to zero under the property test

*Payments*
- [ ] Card tokenized via Paystack; no PAN ever touches JFK
- [ ] Webhook signature verified; duplicate events provably harmless
- [ ] Auto-collection runs on schedule; retry ladder works; hard declines don't retry
- [ ] Payout to a name-verified bank account; failure reverses the reservation cleanly

*Governance*
- [ ] Proposals with per-action thresholds, snapshots, quorum, deadlines
- [ ] Yes/No/Abstain; votes immutable; late votes rejected
- [ ] **No release exists without an approved proposal — enforced by the schema**
- [ ] Execution requires admin + PIN, and is a separate step from approval

*Groups*
- [ ] Both TREASURY and ROTATING types working end to end
- [ ] Invite → join → contribute path works from a phone with no hand-holding
- [ ] Add/remove/promote members; removal governed above 2 members
- [ ] Permission matrix fully covered by the table-driven test

*Experience*
- [ ] Home shows all groups: balance, next payment, action needed
- [ ] Group chat with replies, reactions, mentions, and inline system events
- [ ] Activity feed narrates money and governance events in plain language
- [ ] The 8 essential notifications fire in-app and via push
- [ ] Installs as a PWA; every screen has loading/empty/error/pending states
- [ ] Dark, premium, fast — it should feel like a wallet, not a dashboard

*Trust*
- [ ] You've moved real money in and out end-to-end, and reconciled it by hand
- [ ] A restore from backup has been tested once
- [ ] The group has been told, in plain words, where their money actually sits

---

## Verification

**Per phase:** `pnpm test` (unit + integration against a Testcontainers Postgres) must be green before the next phase starts. Phases 2, 3 and 6 additionally require:

1. **Ledger (Phase 2):** run the reconciliation job manually; run the property test with 1,000 generated operations; confirm system balance = 0 and cached == derived.
2. **Payments in (Phase 3):** with Paystack test keys and ngrok, tokenize a test card, charge it, and replay the same webhook 3× — assert exactly one contribution and one ledger transaction. Then repeat with a **live** ₦100 charge from your own card and confirm the ledger, the group balance, and the Paystack dashboard all agree.
3. **Releases (Phase 6):** end-to-end on live keys with ₦100 — create proposal, vote to threshold, execute with PIN, confirm arrival in the destination account. Then force a failure (invalid recipient) and assert the reservation reverses and `GROUP_AVAILABLE` returns to its exact prior value.
4. **Permissions:** the `(role × action)` table test from §6 must have zero gaps — a missing cell fails the suite.
5. **Full spine (Phase 8):** Playwright E2E from sign-in through executed release, run against a preview deployment on a real phone browser.
