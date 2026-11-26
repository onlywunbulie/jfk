# What the next contract version (v5) changes

Nothing decided yet. Each group's move to a new version is by its own vote
(MIGRATE_MODULE), as for every version.

## Done in v4 (2026-11-26, Base Sepolia)

1. **No "every vote needs a human".** A member can always vote either directly
   or through their helper (their AI). The rules payload keeps its old shape;
   the last field is ignored.
2. **No automatic dues, no collecting your turn** (rotating groups). When a
   turn is paid, anyone in line without a live helper holding the collect
   power goes to the back, keeping their order, and the pot goes to the next
   member who has one. If nobody in line has one, the turn is paid as before.
3. **Everything a successor module needs is readable**: `getShortfalls` lists
   who each unpaid shortfall is owed to. (`totalShort` and `totalPaidIn` are
   gone from the outside: add up `getShortfalls` and `paidIn` instead.)

Groups started on v3 or v2 stay there; v4 is for groups started from
2026-11-26, and for mainnet. A v5 that takes groups over would read their
state through v4's views.
