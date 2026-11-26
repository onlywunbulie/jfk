# Rallied contracts: audit scope and notes

Everything an external reviewer needs to start: what Rallied is, what is in
scope, how to build and test it, who can do what, the properties we rely on,
and what we already know or have accepted. The code comments are written to
be read alongside this file.

## 1. What this is

Rallied is a savings app for small groups of friends (Nigerian *Ajo / Esusu*,
digitised). Each group's money is USDC held in its own **Safe v1.4.1**
wallet on Base. Every member is an owner of that Safe, and the Safe's
signing threshold is always **all members**.

`JfkModule` is a **Safe module**: the only thing that moves a group's money
day to day, and only when the group's own rules allow it. It supports two
kinds of group:

- **Shared pot.** Members pay a fixed contribution in. Money leaves only by
  an approved vote (a spend), a refund when a member is voted out, or the
  group closing.
- **Rotating savings (Ajo).** Each round, everyone pays the contribution and
  the whole pot goes to one member in turn, paid out on schedule. A missed
  payment becomes a public debt, owed to whoever was short that round.

Members can name a **helper**: a key that acts for them within powers they
choose (propose, vote, collect their dues), always with an expiry. In
practice the helper key is held by Rallied's server, acting on what the
member tells their AI assistant.

The contract is deliberately **not upgradeable and has no owner or admin**.
Nobody, including Rallied, can change a group's rules or move its money
outside them. A fix ships as a new module that each group moves to by its
own vote (`MIGRATE_MODULE`).

## 2. Scope

| File | What it is | Lines (approx., no comments) |
|---|---|---|
| `src/JfkModule.sol` | The module: groups, contributions, helpers, proposals, voting, execution, rotation entry points, views | 670 |
| `src/RotationLib.sol` | Rotating savings: order, rounds, debts and shortfalls, cycles, skipping members without automatic dues | 345 |
| `src/SafeOps.sol` | Calls the module makes on the Safe: pay out, add/remove/swap owners, switch module, split the pot on closing | 95 |
| `src/JfkSetup.sol` | Runs inside `Safe.setup` (delegatecall) to enable the module and register the group in the same transaction | 35 |
| `src/interfaces/ISafe.sol` | The parts of Safe the module uses | 26 |

About **1,170 lines** in total. Compiler `solc 0.8.28`, EVM `cancun`,
optimizer on with 200 runs. `RotationLib` and `SafeOps` are **external
libraries** linked into `JfkModule`. `JfkModule` is about 24.2 KB, close to
the 24 KB limit, which is why some code lives in the libraries.

**Commit:** the version to review is pinned when the engagement starts.
Version 4 was completed at `aeee702` (2026-11-26); `VERSION` was corrected
to `"4"` right after it (see §8).

**Out of scope:** Safe itself (audited v1.4.1, used unmodified),
OpenZeppelin 5.7.0 (`IERC20`, `SafeERC20`, `ReentrancyGuard`), USDC, and
everything off-chain (the web app, Rallied's server and keys). The
off-chain parts matter to the trust model in §4, but their code isn't part
of this review.

## 3. Build and test

```bash
git submodule update --init --recursive   # forge-std, OpenZeppelin, Safe v1.4.1
cd contracts
forge build --sizes
forge test                                # unit, fuzz and invariant suites
FOUNDRY_PROFILE=ci forge test             # the same, ten times harder
```

All tests run against the **real Safe v1.4.1 contracts**, never mocks: a
proxy factory, the L2 singleton and `JfkSetup`, exactly as on chain.

| Suite | What it covers |
|---|---|
| `test/JfkModule.t.sol` | Shared-pot groups: registration, contributions, proposals, voting, every action, leaving, closing |
| `test/Helpers.t.sol` | Helpers: powers, expiry, locks, collected dues; no rules change can disable helper votes |
| `test/Rotation.t.sol` | Rotating groups rule by rule, including v4's "no automatic dues, no collecting" and `getShortfalls` |
| `test/Money.invariant.t.sol` | Shared pots under random sequences of everything members can do |
| `test/Rotation.invariant.t.sol` | Rotating groups under random paying, waiting, payouts, covers, leaving and helpers going on and off |
| `test/Tally.fuzz.t.sol` | The vote maths against a port of the app's TypeScript (`src/modules/governance/threshold.ts`) |
| `test/EmergencyExit.t.sol` | The emergency exit with smart-contract-wallet members: every owner `approveHash`es one MultiSend payout, then anyone executes it; one missing approval or a changed payout fails; works with the module switched off |

## 4. Who can do what

| Actor | Can | Cannot |
|---|---|---|
| **A member** (Safe owner) | Pay in; propose; vote; name, change or revoke their own helper; leave | Move money alone; vote twice; vote on proposals opened before they joined |
| **A member's helper key** | Only what its member granted (`POWER_PROPOSE`, `POWER_VOTE`, `POWER_COLLECT`), until it expires (366 days at most). Its vote is the member's one vote, not an extra one. `collect` pulls exactly the contribution from the member into the Safe, at most once per `payGap` | Name a helper; move money anywhere except from its member into their own group's Safe; act after its member leaves, is removed or changes wallet (wiped) |
| **Anyone** | `execute` an approved proposal; `payTurn` when a round is due; `coverDebt` for any member, with their own tokens | Choose who gets paid: the contract decides |
| **All members together** | Act on the Safe directly (threshold = every owner): the emergency exit, which works even without the module | |
| **Rallied** | Holds the helper key members choose to name; runs the daily job that calls `collect` and `payTurn`; pays network fees | Anything a helper or anyone else couldn't. There is no owner, admin, pause or upgrade |

A group is identified by its Safe address. `registerGroup` and
`registerRotatingGroup` take `msg.sender` as the group and require that it is
a Safe with this module enabled and a threshold equal to its owner count.
They are meant to be called from `JfkSetup` during `Safe.setup`.

## 5. How the money moves

**In:** `contribute` (by the member) and `collect` (by their helper) both go
through `_takeContribution`. That function pulls exactly the contribution
with `safeTransferFrom`, refuses fee-on-transfer tokens by checking the
balance change, and records `paidIn` and `lastPaidAt`. In a rotating group it
settles the member's debt first, then counts toward this round.

**Out (shared pot):** an approved `SPEND`; a refund to a member voted out
(their share of the pot in proportion to what they paid in, never more than
they paid in: `refundFor`); `CLOSE_GROUP`, which splits the pot by what each
member paid in (`SafeOps.closeOut`). Every payout goes through
`SafeOps.pay`, which checks the call succeeded, the token didn't report
failure, and the Safe's balance fell by exactly the amount.

**Out (rotating):** `payTurn` pays this round's pot to the member whose
turn it is, once it's due (and, if anyone hasn't paid, once the grace
period is over). Anyone short becomes a debtor of that round's holder; their
next payments go straight to whoever is owed, oldest first. `coverDebt`
lets anyone pay a debt on someone's behalf. Closing refunds the unfinished
round to whoever paid into it, then splits anything left equally (what each
member paid in is cleared first).

**Proposals:** the approval bar, turnout rule and list of eligible voters
are fixed when a proposal opens. Approval is `yes / (yes + no)` and turnout
is `(yes + no + abstain) / eligible`, both rounded half-up. Before the
deadline a proposal passes only once no outstanding votes could undo it.
`decision()` must agree exactly with the app's `threshold.ts`;
`Tally.fuzz.t.sol` checks that.

## 6. Properties we rely on (and test)

Shared pots (`Money.invariant.t.sol`):
1. The pot is exactly what came in minus what went out.
2. Money leaves only three ways: an approved spend, a refund, or closing.
3. A spend pays exactly what was approved.
4. A refund never exceeds what that member paid in.
5. A helper collects exactly one contribution, never two inside one payment gap.
6. Signing on the Safe directly always needs every member.
7. What members have paid in is always backed by what actually came in.

Rotating groups (`Rotation.invariant.t.sol`):
8. Every debt is owed to someone: total debts equal total unpaid shortfalls.
9. Between payouts, the vault holds exactly this round's payments.
10. Every unit of USDC is with a member, a friend who covered a debt, or the
    vault. Never the module, never anyone else.
11. Nobody ever loses or holds two places in the payout order.

Voting (`Tally.fuzz.t.sol`): the contract and the app agree on every
outcome; a "no" vote never helps a proposal pass.

## 7. What's new in version 4

Versions 1 to 3 run groups on Base Sepolia today; v4 is the version for new
groups and for mainnet. Older groups are not moved to v4.

1. **No "every vote needs a human".** v3 let a group vote to switch helper
   votes off. v4 removes the setting: a member can always vote directly or
   through their helper. The `CHANGE_RULES` payload keeps its old 4-field
   shape and ignores the last field; `getGroupSettings` always reports
   `false`.
2. **No automatic dues, no collecting your turn.** Just before a payout,
   `RotationLib.skipToAutoDues` finds the first member in line from the
   current turn who has a live helper with `POWER_COLLECT`. Everyone before
   them keeps their order and goes to the back. If nobody in line has one,
   the turn is paid as in v3. It runs in the same transaction as the payout,
   so if the payout isn't due, the skip is undone too.
3. **State a successor can read.** `getShortfalls` lists every unpaid
   shortfall (creditor and amount, oldest first). `totalShort` and
   `totalPaidIn` were removed from the external interface to fit the size
   limit; they can be derived from `getShortfalls` and `paidIn`. Closing's
   split moved from the module into `SafeOps.closeOut` for the same reason.

## 8. Known issues, accepted risks, and questions for you

1. **`VERSION` on the Base Sepolia v4 instance reads `"3"`.** The source said
   `"3"` when it was deployed and is now `"4"`. Nothing reads it; mainnet
   will be a fresh deployment. Test network only.
2. **USDC's blocklist.** If a payout recipient is blocklisted by Circle,
   `SafeOps.pay` reverts. In a rotating group, that stops `payTurn` until
   the order changes (by vote, `CHANGE_ORDER`) or the member is removed.
   Closing would also revert until they're removed. We'd value your view on
   whether a skip or escrow path is worth its complexity.
3. **"Automatic dues" means a live helper with the collect power,** nothing
   more. The contract doesn't check the member's allowance or balance at
   payout time; a failed collection simply becomes a missed payment, with
   the usual debt rules. A member who paid by hand but has no such helper is
   still skipped: the group agreed automatic dues are a condition of
   collecting.
4. **`MIGRATE_MODULE` can name any contract** (except obvious bad addresses).
   It hands that contract the Safe's module rights and closes the group in
   this module. Protection is the group's vote and its threshold for this
   action (`Rule.MIGRATE_MODULE`). Group state doesn't move automatically;
   a successor reads it through this module's views.
5. **Registration is permissionless.** Any contract that answers like a
   Safe can register itself as a group. Groups are keyed by that address and
   isolated from each other. Please confirm nothing a fake "Safe" registers
   can affect a real group.
6. **Helper lock in rotating groups.** After a member has collected their
   turn, their collect helper can't be revoked or weakened until the cycle
   ends. They can still change it, but only to a helper that keeps the
   collect power and expires no earlier (any key). This is so someone who
   has received everyone's money keeps paying.
7. **Loops are bounded** by `MAX_MEMBERS = 50`: owners, order, voters and
   closing.
8. **Timing uses `block.timestamp`**: voting deadlines, payment gaps, round
   dates, grace and helper expiry. All of these are days apart, not seconds.
9. **External libraries.** `RotationLib` and `SafeOps` are linked and called
   from the module's context. `RotationLib` imports `JfkModule` for the
   `Helper` type (a circular import that compiles). Please check the
   storage-pointer parameters (`State`, `mapping(address => Helper)`,
   `mapping(address => uint256)`) for any way to reach another group's
   storage.

Areas we'd most like scrutiny on: the rotation state machine (`payTurn`,
`skipToAutoDues`, `_newCycle`, `setOrder`, removal mid-cycle), debt and
shortfall accounting with partial covers, `refundFor` and closing after
spends, helper powers and locks, and `decision()` at its edges (ties,
abstentions, members removed mid-vote).

## 9. Deployments (Base Sepolia, chain 84532)

From `deployments/base-sepolia.json`:

| | Address |
|---|---|
| `JfkModule` v4 | `0xd3E740d6ec186be9e4073367dd9f54caae175Db0` |
| `JfkSetup` v4 | `0x6D418561efABD8270500aD7EA1a2f0079fCA61bE` |
| `RotationLib` | `0x880D762c726155f9bB24fa2758432bF0Eb836A5F` |
| `SafeOps` | `0xa228d3b3D1D2140572d9e42b245971Bb35356fCc` |
| Safe L2 v1.4.1 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Safe proxy factory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| USDC (Circle, test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Earlier versions (v1 to v3) and their addresses are listed in the same file.
No mainnet deployment exists; it waits on this review.

## 10. Further reading

- `BLUEPRINT-WEB3.md`: the on-chain design and its reasoning, including
  the risk table (§15) and the rotating-group rules (§10).
- `NEXT-VERSION.md`: what changed in v4 and what's queued for later.
- The NatSpec in each source file, which states each rule in plain words.
