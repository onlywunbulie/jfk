# Getting your group's money out without Rallied

Every Rallied group keeps its money in its own vault on Base: a Safe
wallet that all of you own together. Rallied can't take that money, and if
Rallied or its contract ever stops working, **all of you together can pay
the vault out to yourselves**. Nobody can do it alone: every member has to
approve.

While Rallied's website still works, use the **Emergency exit** page instead:
it's linked from your group's **#rules**, and does everything below with a
couple of taps each. This guide is for when it doesn't.

## What you need

- Your group's **vault address**. It's the BaseScan link in your group's
  #about or #rules (it starts with `0x`). Any member who saved it can share it.
- Every member, each with the wallet they used for Rallied.
- A little ETH on Base in each member's wallet for the network fee. It's
  less than a cent per step.

## Step 1: work out the exact payout

Every member must approve **the same** transaction, so first one person
works it out. Someone with a computer runs this from a copy of Rallied's code
(https://github.com/onlywunbulie/jfk), with Node.js installed:

```bash
pnpm install
pnpm exit:plan 0xYOUR_VAULT_ADDRESS
```

It reads Base only (no Rallied account, database or password needed) and
prints:

- how the money will be split, and who has approved so far;
- the **hash to approve** (a long code starting `0x`);
- the exact values for the final step.

The split follows your group's own closing rule. A shared pot is split by
what each person paid in. In a rotating group (Ajo), this round goes back to
whoever paid into it, then the rest is shared equally. If Rallied's contract
can't be read at all, the money is split equally.

Share the printed output with the group.

## Step 2: every member approves

Each member, from their own wallet:

1. Open `https://basescan.org/address/0xYOUR_VAULT_ADDRESS`
   (on the test network: `https://sepolia.basescan.org/...`).
2. Go to **Contract → Write as Proxy**, then **Connect to Web3** and connect
   your wallet.
3. Find **approveHash**, paste the hash from step 1, and press **Write**.
   Confirm in your wallet.

Running `pnpm exit:plan` again shows who has approved.

## Step 3: anyone pays everyone out

Once every member has approved, **anyone** (one of you, or a friend) sends
the final transaction. It can only pay out the split everyone approved.

1. On the same BaseScan page, under **Write as Proxy**, find
   **execTransaction**.
2. Fill in each field with the values `pnpm exit:plan` printed (`to`,
   `value`, `data`, `operation`, `safeTxGas`, `baseGas`, `gasPrice`,
   `gasToken`, `refundReceiver`, `signatures`), then press **Write**.

Each member's share arrives in their own wallet.

## If something goes wrong

- **"GS025"** means not everyone has approved this exact transaction yet.
  Check with `pnpm exit:plan`.
- **The amounts changed.** If money came into or left the vault after step
  1, the payout is different, and so is its hash. Start again from step 1;
  earlier approvals simply don't count.
- **Safe's own app** (app.safe.global) can also manage your vault. It may
  ask your wallet for a kind of signature that smart wallets (like Coinbase's)
  can't give. If it does, use the BaseScan steps above, which work with any
  wallet.

## Why this always works

Your vault's own rules say a transaction needs **every member**. Rallied's
contract is only an add-on that the vault allows in. The steps above don't
use it at all, so they work even if Rallied's contract, website and servers
are all gone. This is tested against the real Safe contracts with
smart-wallet members (`contracts/test/EmergencyExit.t.sol`).
