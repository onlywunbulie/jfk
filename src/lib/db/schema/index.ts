/**
 * The database schema, assembled per module.
 *
 * Modules own their tables. Only `modules/ledger` may write to the ledger_*
 * tables (added in Phase 2) — see BLUEPRINT.md §12.
 */
export * from "./identity";
