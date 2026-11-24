# What the next contract version (v4) changes

Decisions already made that need a contract change. Each groups' move to v4
is by its own vote (MIGRATE_MODULE), as for every version.

1. **Drop "every vote needs a human"** (`humanVotesOnly`, set by CHANGE_RULES).
   Members must always be able to vote either in Rallied or through their
   AI, never only in Rallied. Until then, Rallied never offers the setting
   and sends it off in every rules change (`src/modules/agents/send.ts`).

2. **Enforce automatic dues in rotating groups: no automatic dues, no
   collecting your turn.** When a member's turn comes and they have no live
   helper with the collect power, they move to the back, as if they'd
   missed. v3 can't check it, so for now Rallied requires it in the app
   (#about, #payout order, Claude, the join page).
