# JFK on-chain — Build Plan

**Drafted:** 21 October 2026
**Replaces:** [BLUEPRINT.md](./BLUEPRINT.md) once building starts. Until then that file still
describes the code in this repo.

> ### Scope: real money, eventually. Testnet first.
>
> This changes the portfolio-only scope recorded in [HANDOFF.md](./HANDOFF.md) (decided
> 21 October 2026). JFK is now meant to hold real dollars for real friend groups.
>
> It is still **built on Base Sepolia**, Base's test network, with test USDC that has no value,
> until every item on the mainnet gate (§13) is done. But the contract is written **to audit
> standard from the first line**: real money is the target, so nothing gets built as a
> prototype to be hardened later.

---

## 1. Decisions

| Decision | Choice | Why |
|---|---|---|
| Who it's for | Friend groups only | Trust between members is assumed; nothing here tries to make strangers safe with each other |
| Real money | **Yes, eventually.** Testnet until the mainnet gate (§13) is passed | |
| A member who leaves | **Forfeits what they've paid in.** It stays with the group | Leaving means not committing to the round; the group shouldn't carry the cost (§6) |
| Where it runs | Web only (installable on a phone's home screen) | No WhatsApp or Telegram bot |
| Blockchain | **Base** | Low fees, native USDC, the most mature fingerprint (passkey) wallets |
| Money | **USDC**, a dollar stablecoin | Protects savings from naira inflation; no price swings |
| Where the pot lives | **One Safe per group**, plus a JFK add-on (a Safe "module") that enforces the group's rules | Safe is the most battle-tested shared wallet there is; our own code stays small |
| Network fees | **Paid by the app** through a paymaster | Members never hold ETH; switching to "members pay in USDC" later is a configuration change |
| Token | **None** | Adds securities exposure and nothing a savings circle needs |
| Notifications | Email and browser push | Web only |
| Standout feature | **Cover a friend** | Private, interest-free help with a missed contribution, repaid automatically |
| AI | **A group agent with a contract-limited wallet, and an in-app assistant** | The agent does housekeeping it can't abuse; the assistant answers questions and drafts proposals for a person to sign (§17) |

---

## 2. What JFK becomes

A group of friends saves together in dollars. The money sits in a wallet on the blockchain that
**no single person controls, including whoever built the app**. It only moves when the group's
own rules say so, and those rules are enforced by code anyone can inspect.

The two kinds of group stay exactly as they are today:

- **Save together** (`TREASURY`): money builds up and only leaves when enough members vote yes.
- **Take turns** (`ROTATING`, Ajo): each round, one member collects the whole pot, in turn.

What the move on-chain actually changes for users:

1. **Nobody holds the money.** Today it would settle into one person's Paystack balance. Now it
   sits in the group's own Safe.
2. **The vote rule can't be bypassed.** It is the only way the contract will release money.
3. **The books check themselves.** Every contribution and payout is publicly verifiable.

What it must not change: setting up a group is still the question-by-question conversation, the
wording is still plain, and nobody ever sees a recovery phrase, a gas fee or a hex address unless
they go looking.

---

## 3. What carries over, what changes, what goes

| Today | On-chain | Notes |
|---|---|---|
| UI, design system, glass theme | **Carries over** | |
| Create-group conversation (`groups/new/script.ts`) | **Carries over** | Its last step now deploys a Safe instead of inserting rows |
| Plain-language copy | **Carries over** | Extended to anything wallet-related |
| Groups, members, invites, roles (`modules/groups`) | **Carries over, mostly** | Membership must now be mirrored in the Safe's owner list (§6) |
| Governance rules: per-action bars, turnout, snapshots (`modules/governance`) | **Moves into the module** | The Postgres version becomes a read model of the contract |
| Contribution cycles and schedule maths (`modules/contributions/schedule.ts`) | **Carries over** | Still decides *when* things are due; the contract decides *whether* money moved |
| Double-entry ledger (`modules/ledger`) | **Becomes a chain index** | Balances are read from the chain, never written by us. The rule "balances are derived, never stored" survives in a stronger form |
| Monthly raised chart (`getMonthlyRaised`) | **Carries over** | Fed from indexed contribution events instead of ledger rows |
| `Money` (`lib/money.ts`) | **Changes** | USDC has 6 decimal places, not 2. `Money` must learn per-currency precision before anything else is built |
| Paystack, card tokens, webhooks, `fees.ts` gross-up | **Goes** | |
| Card retry ladder (`contributions/retry.ts`) | **Goes** | Replaced by "the pull failed, remind the member" |
| Transaction PIN | **Goes** | The passkey confirmation replaces it |
| Email sign-in codes | **Changes** | Sign-in becomes the wallet itself (§5) |
| Audit log | **Shrinks** | The chain is the audit trail for money; Postgres keeps it for everything else |

---

## 4. Architecture

```
  Browser (Next.js app, installable)
     │  ├─ passkey wallet: signs votes and contributions with a fingerprint
     │  └─ reads balances through the app's API (fast) or the chain (to verify)
     ▼
  Next.js server ─────────────── Postgres
     │  ├─ group names, descriptions, proposal text (never put on-chain)
     │  ├─ notifies members when a vote is waiting
     │  ├─ indexer: copies contract events into Postgres for the dashboard
     │  ├─ jobs: collects due contributions, closes proposals, sends reminders
     │  └─ paymaster: pays network fees for app-initiated transactions
     ▼
  Base (Sepolia for now)
     ├─ one Safe per group ── holds the USDC
     └─ JfkModule (one deployment, serves every group)
          ├─ per-action approval bars and minimum turnout
          ├─ contribution pulls and rotating payouts
          └─ cover-a-friend debts
```

### The trust boundary

Everything above the chain can be wrong, slow or offline without risking anyone's money:

- The server **cannot forge or hide a vote**. Each member casts their vote from their own wallet,
  straight to the contract, which does the counting.
- The server **cannot move money**. Only the module can, and only when its rules are met.
- The worst the server can do is fail to **remind** people. Carrying out a passed proposal is
  open to anyone, so nothing depends on the server being up.

### What lives where

| On-chain | Off-chain (Postgres) |
|---|---|
| The money | Names, descriptions, profile details |
| Who the members are (Safe owners) | Proposal titles and reasons |
| Each group's rules: bars, turnout, cadence, amount, turn order | Notification preferences |
| Proposals, every vote, and the tally | Who has been reminded about what |
| Contributions, payouts, cover debts | A fast copy of on-chain events |

Text stays off-chain on purpose: it's cheaper, it's editable, and a blockchain is public forever.

---

## 5. Wallets and sign-in

Every member has their own **smart wallet secured by a passkey**: Face ID, a fingerprint, or the
device's screen lock. There is no seed phrase. Signing in to JFK *is* unlocking that wallet.

**Provider: Coinbase Smart Wallet** (decided 21 October 2026). Free, built for Base, works with
paymasters out of the box. Members briefly see a Coinbase-branded window when they confirm
something; the app should say so before the first time, so it doesn't look like a redirect to
somewhere unexpected.

The alternative considered was an embedded-wallet provider (for example Privy or Turnkey): fully
JFK-branded, but paid. Keep wallet access behind one interface, as Paystack is today, so switching
later is contained.

**Recovery.** Passkeys sync through iCloud Keychain and Google Password Manager, so a lost phone is
not a lost wallet. A member who loses every device can still be replaced in the group by a vote
(`REPLACE_MEMBER_WALLET`, §6), so their share is never stranded.

---

## 6. The Safe and the module

### One group, one Safe

Creating a group deploys a new Safe through Safe's standard factory:

- **Owners:** every member's smart wallet.
- **Direct-signing threshold:** *all* owners. A payment signed directly on the Safe, around JFK's
  rules, needs every single member. That's the emergency exit: if JFK disappeared, the friends
  could still recover the money together, but nobody can use it as a shortcut.
- **Enabled module:** `JfkModule`, configured with the group's rules from the setup conversation.

### `JfkModule`: what we write

One contract, deployed once, that every group's Safe enables. It is the only Solidity in the
project, and keeping it small is a design goal. Responsibilities:

1. **Store each group's rules**: approval bar per action, minimum turnout, contribution amount,
   cadence, group type, turn order.
2. **Proposals.** Opening a proposal records its hash, action, amount, recipient, deadline and a
   snapshot of who may vote.
3. **Count votes on-chain.** Each member casts yes, no or not sure from their own wallet, one
   transaction per vote, and the contract keeps the tally. Once the proposal has passed, anyone
   can carry it out. Same maths as today's governance module, checked by a fuzz test against a
   port of it: `approval = yes / (yes + no)`, abstentions count towards turnout only.
4. **Pull contributions** from members who pre-approved it (§7).
5. **Rotating payouts** to whoever's turn it is.
6. **Cover-a-friend debts** (§9).
7. **Membership changes** (add, remove, replace a wallet) go through the same proposal flow, and
   the module updates the Safe's owner list itself, so the two can never disagree.
8. **The group's agent role** (§17): one address per group that may call only the housekeeping
   functions. Every other function refuses it.

**Why votes are cast on-chain, one at a time** (changed while building Phase 1). The first draft
had members sign votes off-chain and the server submit them in one batch, to save fees. Building
it showed the flaw: after the deadline, whoever submits the batch decides which votes go in, and
could quietly leave out the "no" votes. Counting each vote on-chain removes that. The cost is a
fee per vote, a fraction of a cent on Base, paid by the paymaster.

**Who can vote.** Everyone who was a member when the proposal opened, provided they are still a
member when they vote. Someone who joins mid-vote waits for the next one; someone who leaves or is
removed keeps their place in the count but loses their voice. That second rule is stricter than
the app today (which shrinks the count instead), and it can only make passing harder, never
easier.

**A turnout quirk, inherited from the app.** With a minimum turnout, a brand-new "no" vote can
tip a proposal into passing by lifting turnout over the line (for example, 1 yes of 2 fails a 60%
turnout; add 1 no and it's 2 of 2 at 50% approval, which passes a 50% bar). A member who wants
something to fail may be better off not voting. It's how turnout rules work everywhere; worth
knowing, and worth explaining in the app.

### When a member leaves

Decided with the user: **a member who leaves forfeits everything they've paid in.** It stays in
the group's Safe. Leaving is choosing not to commit to the round, and the people who stay
shouldn't absorb that.

How the module applies it:

1. **Leaving is the member's own signed action.** No vote needed; anyone may walk away. The module
   removes them as a Safe owner and from future cycles, votes and turns.
2. **Their contributions are not refunded.** Nothing moves out of the Safe.
3. **Cover debts owed *to* them are cancelled.** They gave up their claim on the group, and
   the friend who owed them keeps paying into the group as normal.
4. **Cover debts owed *by* them are paid to the friend who covered them, out of the pot.** The
   helper did the leaver a favour, not the group, so the helper shouldn't lose out because of
   someone else's decision to leave. This is the one exception to "nothing moves out".
5. **In a rotating group, any turn they hadn't reached yet is removed** and the remaining order
   closes up.

The rule is shown in plain words during the setup conversation and again on the "Leave group"
screen: *"If you leave, what you've paid in stays with the group."* Nobody should discover it by
surprise.

### The three related cases

Decided with the user on 21 October 2026.

**Leaving after collecting a turn (rotating groups).** The member has taken out more than they
put in, and the contract can't make them pay the rest. The module records what they still owed
(what they collected minus what they paid in) and the group is told, plainly and once. JFK does
not chase them; among friends, that's for the group to handle.

**Removed by a vote.** Being voted out isn't a choice to stop committing, so **the member gets
their money back**. What "their money" means, in order:

1. Start from what they've paid in, minus anything they've already collected in a rotating group.
2. **If the group has spent money since, they share that cost.** Their refund is their share of
   what's in the pot now, in proportion to what they paid in, never more than step 1. Otherwise a
   treasury group that has spent half its pot could owe a removed member more than the pot holds.
3. Any cover debt they owe is paid to the friend who covered them first, out of that refund.
4. Any cover debt owed *to* them is paid to them from the pot, and the borrower now owes the
   group instead.

**The whole group closes.** The pot is split **in proportion to what each member paid in**:

1. Outstanding cover debts are settled first, so every helper is made whole.
2. In a rotating group, what each member already collected is subtracted from what they paid in.
3. What's left is divided in proportion to each member's remaining paid-in amount. Rounding dust
   (USDC has 6 decimal places) goes to the last member in the list, stated in the code, so the
   Safe ends at exactly zero.

### Fixing a bug after launch

With real money, the plan has to assume a bug will be found eventually. The module is **not
upgradeable**: nobody, including JFK, can change the code that holds a group's rules. Instead:

- A fixed version is deployed as a **new** module.
- Each group moves to it by proposal, at the "change these rules" bar: enable the new module,
  disable the old one. The money never leaves the Safe during the switch.
- If a bug is serious enough that the old module can't be trusted to run that proposal, the
  all-members emergency exit on the Safe can make the switch directly.

Upgradeable contracts are more common, but they mean whoever holds the upgrade key can change the
rules of every group at once. That's exactly the power JFK says nobody has.

### Actions the module understands

Unchanged from today's governance, plus one:

| Action | Default bar |
|---|---|
| Spend a small amount (up to 20% of the pot) | Half of the group |
| Add a member (new; joining is a vote on-chain) | Half of the group |
| Spend a big amount | 2 out of every 3 |
| Change how much people pay | 2 out of every 3 |
| Change these rules | 3 out of every 4 |
| Remove a member | 2 out of every 3 |
| Move the group to a new module version | 3 out of every 4 |
| Remove an admin (an app role; admins don't exist on-chain) | 3 out of every 4 |
| Change whose turn is next | 2 out of every 3 |
| Close the group | 4 out of every 5 |
| **Replace a member's wallet** (new) | 3 out of every 4 |

---

## 7. Contributions

**Set it once.** On joining, a member approves the module to take up to their contribution amount
each cycle from their wallet. This is a standard token allowance, revocable at any time.

**Each cycle:**

1. The schedule (today's `schedule.ts`) says a cycle is due.
2. A job calls `collect(group, member)` on the module, fee paid by the paymaster.
3. If the member's wallet has enough USDC, it moves into the Safe and an event is emitted.
4. If not, the pull fails, the contribution is marked **missed**, and the member is reminded
   privately. They can pay manually with "Pay now", or a friend can cover them.

There is no retry ladder: a failed pull costs nothing, so the job simply tries again on the next
scheduled run until the grace period ends.

**Getting USDC in (open decision §14.5).** On testnet, members get test USDC from a faucet; the
app can show a "Get test dollars" button. On mainnet this needs an on-ramp (naira → USDC), which
is the hardest real-world step and out of scope for the portfolio build.

**Showing naira** (decided: yes). Everything is held in dollars, and amounts are also shown in
naira at a live rate, labelled as an estimate: *"$50 · about ₦X"*. The rate is display-only and
never touches the contract.

Which rate matters in Nigeria, because the official rate and what people actually pay can differ
widely. Show the rate people can really get (a market or peer-to-peer USDT/USDC rate), say where
it comes from, and cache it so a failed rate lookup never blocks the page. Source chosen in
Phase 3.

---

## 8. Proposals and voting

1. A member opens a proposal in the app: "$300, wedding gift for Chidi."
2. The app records the text in Postgres and opens the proposal on-chain (hash, deadline, voter
   snapshot). Fee paid by the paymaster.
3. Members are notified by email and push. Each one opens the proposal, taps **Yes**, **No** or
   **Not sure**, and confirms with their passkey. That sends their vote to the contract.
4. As soon as the votes clear the bar *and* the turnout rule (and nothing the remaining members
   could do would change it), the proposal can be carried out. The app does it straight away;
   anyone else could too. The Safe pays the recipient.
5. If the deadline passes without enough votes, the proposal expires. Nothing moves.

**Recipients.** A spend pays a wallet address. Paying a vendor's bank account directly needs an
off-ramp, which is out of scope until mainnet.

**Reserving money.** Today an approved proposal reserves funds until the payout lands. On-chain,
approval and payment happen in the same transaction, so there's nothing to reserve and no
reserved balance to show.

---

## 9. Cover a friend

Decided with the user:

| Question | Answer |
|---|---|
| Who knows? | **Only the two people involved.** The group sees "Amaka's share is paid", not who paid it |
| How is it asked for? | **The member asks a specific friend directly** in the app |
| How is it repaid? | **Rotating groups:** taken automatically from the borrower's next payout, before they receive the rest. **Treasury groups:** gentle reminders. **If the borrower leaves:** the helper is repaid from the pot (§6) |
| Where is the debt recorded? | **On-chain**, so repayment is enforced by the contract |
| Interest? | **None** |
| Limits? | **After two covers in a row, the group is told** |

### Flow

1. Amaka's pull fails. In the app she taps "Ask a friend" and picks Tunde.
2. Tunde gets a private notification: "Amaka is $50 short for October. Cover her?" He confirms
   with his passkey.
3. The module takes $50 from Tunde's wallet into the Safe, marks Amaka's contribution paid, and
   records that Amaka owes Tunde $50.
4. In a rotating group, on Amaka's next payout the module sends $50 to Tunde first and the rest to
   Amaka. Both are notified.

### Private in the app, not secret on the chain

Decided with the user: **the debt is recorded on-chain**, so repayment from the payout is enforced
by the contract rather than left to goodwill.

The trade-off, accepted knowingly: a blockchain is public. JFK never shows the group who covered
whom, but the debt record is visible to anyone who reads the contract and can link wallets to
people. "Private" means *private in JFK*. The app should say so in one line when someone asks
for or gives a cover.

---

## 10. Rotating groups

- **Turn order** is set when the group is created and stored in the module. Later: draw it with
  verifiable on-chain randomness, so nobody can claim the organiser put themselves first.
- **Payout** happens once every member's contribution for the round is in, or when the grace
  period ends, whichever comes first.
- **A short round** (decided 21 October 2026): if someone hasn't paid by the end of the grace
  period, the member whose turn it is gets what's there, on time. The missing contribution
  follows to that same member whenever it arrives, whether the late member pays it or a friend
  covers it. Nobody's turn is skipped and nobody waits on someone else's lateness.
- **Cover debts** are settled out of the payout first (§9).

---

## 11. Notifications

Email (Resend, already wired) and web push. What triggers them:

- A contribution is due in 2 days; it was collected; the pull failed.
- A proposal is opened; voting closes tomorrow; it passed or expired.
- It's your turn to collect; you've been paid.
- Someone asked you to cover them; your cover was repaid.

Reminders about missed payments go **only to the person concerned**, never to the group.

---

## 12. Building and testing

### Stack additions

| Need | Choice |
|---|---|
| Contract language and tests | Solidity with **Foundry** |
| Safe contracts | `safe-smart-account` (the audited contracts), deployed through Safe's factory |
| Chain access from TypeScript | **viem** (and wagmi in the browser) |
| Smart wallets and paymaster | Coinbase Smart Wallet SDK + Coinbase Developer Platform paymaster, or the equivalent from the chosen provider |
| Indexer | Start with a viem log poller writing to Postgres; move to Ponder only if it outgrows that |

Everything else (Next.js, Postgres, Drizzle, Vitest) stays.

### Testing the contract

The module is where a bug costs money, so it gets the discipline the ledger got:

- **Unit tests** for every action, bar and turnout combination: the same table today's
  governance tests use.
- **Fuzz tests**: random votes, amounts and member counts must never pay out without a valid
  passing vote.
- **Invariant tests**, mirroring the current ledger's:
  - money only leaves a Safe through a passing proposal, a rotating payout or a cover repayment;
  - the sum of all members' contributions minus everything paid out equals the Safe's balance;
  - no cover debt is ever repaid twice;
  - a removed member can never vote;
  - a voted-out member's refund never exceeds what they paid in, and never leaves the pot short of
    what other members' refunds would need;
  - closing a group pays out exactly the Safe's balance, to the unit, with nothing left over.
- **Fork tests** against Base Sepolia with the real Safe contracts.

The app keeps its Vitest suite. Tests that hit the ledger move to testing the indexer against
recorded chain events.

---

## 13. Phases

Each phase ends with something you can demonstrate.

**Phase 0: Money learns decimals (1–2 days).**
`Money` gains per-currency precision so USDC's 6 decimals are exact. *Done when the existing
suite passes and USDC amounts round-trip exactly.*

**Phase 1: The contract (7–9 days) ← do not rush this.**
`JfkModule`: rules, proposals, on-chain voting, membership changes, refunds and closing. Full Foundry suite
including fuzz and invariant tests. Deployed to Base Sepolia. *Done when a scripted group passes a
proposal and pays out on testnet, and a short or late vote is refused.*

*Status, 21 October 2026:* the contract and its suite are built (38 unit tests, 2 fuzz tests run
2,000 times each against a port of the app's vote maths, 6 money invariants over random
sequences). **Deployed to Base Sepolia on 22 October 2026** and run end to end by a script: a group
created, paid into, a spend proposed, voted and paid out. Addresses in
`contracts/deployments/base-sepolia.json`.

**Phase 2: Wallets and groups (4–5 days).**
Passkey sign-in, the create-group conversation deploying a Safe with the module enabled, invites
that add the joiner as an owner. *Done when two people on two phones are in the same on-chain
group.*

**Phase 3: Contributions and the index (5–6 days).**
Allowance on joining, scheduled pulls, "Pay now", the test-USDC faucet button, the indexer, and the
dashboard and monthly chart reading indexed data. *Done when a cycle collects from two members and
the chart shows it.*

**Phase 4: Voting (4–5 days).**
Opening proposals, voting with passkey confirmation, carrying out passed proposals, expiry.
*Done when a proposal passes from three phones and the payout appears on the block explorer.*

**Phase 5: Rotating groups and cover a friend (5–6 days).**
Turn order, payouts, cover requests, automatic repayment from payouts, the two-in-a-row rule.
*Done when a covered member's next payout repays their friend automatically.*

**Phase 5b: The agent and the assistant (5–6 days).**
The group agent's wallet (AgentKit) taking over the housekeeping jobs through its contract role,
plus the in-app assistant: questions answered from the group's data, and proposals drafted for a
human to sign. *Done when the agent collects a cycle and pays out a turn on its own, a test proves
it can't do anything else, and "get mum a generator, about 400k" becomes a proposal draft.*

**Phase 6: Notifications, polish, deploy (4–5 days).**
Email and push, empty and error states for every wallet failure (passkey cancelled, pull failed,
network slow), README, deployed link on testnet. *Done when a friend can open the link, get test
dollars and see a group work end to end.*

**About 6–8 weeks solo to a complete testnet app.** Phases 1 and 5 carry the real risk.

**Phase 7: The mainnet gate (open-ended; mostly not code).**
Nothing on mainnet until every box is ticked:

- [ ] Run a real friend group on testnet for at least two full cycles, and fix what it reveals
- [ ] `JfkModule` frozen (no changes) and **independently audited**, with every finding fixed and
      re-checked. Budget for this: a contract this size is still a meaningful cost
- [ ] **Legal advice** on running a pooled-savings app in Nigeria, even one that never holds the
      money, before any real dollar goes in
- [ ] A **naira on-ramp and off-ramp** chosen and integrated, so friends can get money in and out
- [ ] The **module-migration path** (§6) rehearsed on testnet: a group moved to a new version
      with its money intact
- [ ] The **emergency exit** rehearsed: a group recovering its money with every member signing
      directly, without JFK's server
- [ ] Paymaster budget and abuse limits in place
- [ ] Start with a **deposit cap per group** for the first months on mainnet, raised once nothing
      has gone wrong

---

## 14. Open decisions

Settled on 21 October 2026: real money eventually (testnet first), cover debts on-chain, a
leaving member forfeits what they've paid in, a voted-out member is refunded, and a closing
group splits the pot by what each paid in.

1. *(settled)*
2. *(settled: Coinbase Smart Wallet)*
3. *(settled)*
4. *(settled: §6, "The three related cases")* Leaving after collecting: record what's owed and
   tell the group. Voted out: refunded, sharing any spending since. Group closes: split in
   proportion to what each paid in.
5. **On-ramp and off-ramp for mainnet.** Not needed on testnet; required by the mainnet gate.
6. *(settled: pay out what's there; the late contribution follows, §10)*
7. **Naira rate source.** Showing naira is settled; which rate feed to use is chosen in Phase 3.

---

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A bug in `JfkModule` freezes or loses a pot | 🔴 High | Small, non-upgradeable contract; fuzz and invariant tests; independent audit; a rehearsed migration path; the all-members emergency exit; deposit caps on early mainnet groups |
| Running a money app for real people without the right legal footing | 🔴 High | Legal advice is on the mainnet gate, not an afterthought; JFK never holds the money, which helps but doesn't settle it |
| A member feels cheated by forfeiture | 🟠 Medium | The rule is shown in plain words at setup and on the leave screen; the helper exception keeps covers fair |
| Members lose access to their wallets | 🟠 Medium | Synced passkeys; the replace-wallet proposal |
| A non-crypto friend finds wallets confusing | 🟠 Medium | No seed phrases, no gas, plain wording; never show an address unless asked |
| The server is down | 🟡 Low | Money is never at risk; votes go straight to the contract and anyone can carry out a passed proposal |
| Wallet or paymaster provider changes terms | 🟡 Low | Wrap them behind one interface, as Paystack is today |
| Public chain reveals who contributed what | 🟡 Low among friends | Addresses aren't names; covered in §9; worth stating in the app |
| The agent's key is stolen | 🟡 Low | The contract role only allows housekeeping that the rules already demand, so a thief can only trigger what would have happened anyway; paymaster limits cap any spam |
| The assistant drafts something wrong | 🟡 Low | It only drafts. Every proposal is read and signed by a person before anything happens |
| Scope creep into strangers, tokens or chat bots | 🟡 Medium | All three were considered and explicitly rejected; this plan is the contract |

---

## 16. Building in public

Decided 21 October 2026: JFK is built in public. Each phase has natural moments worth posting, and
the posts should show the engineering and the reasoning, not just screenshots.

### Where

- **X** for the main thread of updates. The Base and onchain-builder crowd is there.
- **Farcaster** for the same updates; Base's own community is active there.
- **LinkedIn** for the bigger milestones only, written for people outside crypto.
- **The GitHub repo**, made public before the first post, with a README that says what JFK is and
  links the plan.

### What to post, phase by phase

| When | Post |
|---|---|
| Before Phase 0 | **The pivot.** "I built a group savings app on Paystack. I'm rebuilding it on Base. Here's why: today, my friends' money would sit in my bank account." The custody argument is the hook |
| Before Phase 0 | **The idea, for non-crypto people.** What Ajo is, why it runs on trust, and what changes when nobody holds the money |
| Phase 0 | **A small, sharp lesson.** USDC has 6 decimal places, not 2, and why money must never be a float |
| Phase 1 | **The architecture.** Safe holds the money, one small module holds the rules: why not write the vault yourself |
| Phase 1 | **The contract's promises, as tests.** "Money can only leave three ways" and the invariant tests that prove it. Developers like this one |
| Phase 1 | **Why the contract can't be upgraded**, and how bugs get fixed anyway |
| Phase 2 | **A short screen recording**: creating a group by answering questions, then signing in with Face ID. No seed phrase on screen |
| Phase 3 | **The monthly chart filling up** from real testnet transactions, with a block explorer link |
| Phase 4 | **Three phones voting**, and the payout landing on-chain. Video works best here |
| Phase 5 | **Cover a friend**, the feature post. Lead with the human story: someone is short, a friend steps in, repaid automatically, nobody else knows |
| Phase 5b | **The agent that can't steal.** A group agent with its own wallet doing the housekeeping, and a test showing the contract refusing it when it tries anything else. The answer to "would you let AI near your money?" |
| Phase 6 | **Launch on testnet.** A link anyone can try with test dollars |
| Phase 7 | **The audit and the road to real money**, including what the audit found. Honesty about findings builds more trust than a clean report |

Between milestones, small posts are fine: a bug and its fix, a design before/after, a decision and
why it went the way it did.

### Never post

- Private keys, seed phrases, API keys, `.env` contents, or screenshots that include them.
- Friends' real names, wallet addresses or contribution amounts without their say-so.
- Anything that sounds like an investment: no "earn", "returns" or "yield" promises, and no
  suggestion of a token. JFK has no token, and saying so plainly heads off scam accusations.
- A mainnet link before the mainnet gate (§13) is passed.

---

## 17. The agent and the assistant

Decided 21 October 2026. Two pieces, both built on one rule: **AI helps people, but it never holds
the group's money, never votes, and never signs for anyone.** Every money decision still needs a
human's passkey.

### The group agent: a wallet the contract keeps in check

Each group gets an agent with its own wallet on Base (Coinbase AgentKit). The module gives that
wallet one narrow role, set when the group is created:

| The agent may | The agent may not |
|---|---|
| Collect contributions that are due | Open a proposal |
| Close a vote whose deadline has passed | Vote |
| Pay out a rotating turn that's already owed | Move money anywhere the rules don't already send it |
| Carry out a proposal the members already passed | Change any rule, member or threshold |

These limits are enforced by the contract, not by the agent's instructions. Every function outside
the left column refuses the agent's address. If its key were stolen, the thief could only trigger
what the rules would have done anyway.

This replaces the plain server jobs for those tasks; the jobs in §4 become the agent's schedule.
Members can see the agent in the group's member list, labelled as such, with everything it has
done.

**Tests.** The invariant suite (§12) gains one rule: *nothing the agent's address calls can move
money except an action the rules already require.* Fuzz it with random calls from that address.

### The assistant: answers and drafts, in plain language

Inside the app, members can ask:

- "How much have we saved this year?"
- "Who hasn't paid for October?"
- "What did we spend on in the summer?"

It answers from the group's indexed data (read-only). It can also **draft** a proposal: "get mum a
generator, about 400k" becomes a filled-in proposal with the amount converted to dollars, a title
and a reason. The member reads it and signs it with their passkey. The assistant never submits
anything.

Built with Claude through the Anthropic API, with read-only tools over the group's data and one
`draft_proposal` tool that returns a draft to the screen.

**Switched on per group, off by default.** Using the assistant sends group details to an AI
provider, and the group should choose that knowingly. It also costs a little per question, so
limit questions per member per day.

### Deliberately not built

An agent that invests the group's money, chases late members on its own, or votes for anyone.
Each breaks the promise that nobody moves the money alone.
