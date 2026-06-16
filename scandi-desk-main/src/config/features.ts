// Frontend feature flags — single source of truth, edit one line to flip.
//
// Why a separate module instead of inline `if`s:
//   · Predictable: every feature is in one place; a future hide/show
//     decision is a one-line PR, not a hunt across 20 files.
//   · Audit-friendly: `grep PUBLIC_RECORDS_ENABLED` shows every surface
//     that consults the flag, so nothing slips through hidden.
//   · Reversible: re-enabling a hidden feature is literally flipping
//     `false` → `true`. No code rewrite, no buried conditionals.
//
// Adding a flag: declare it `as const`, add a comment explaining what
// the feature is and under what conditions it should be re-enabled.

/**
 * Hides every public-records / listafirme.ro / multi-year-history UI
 * surface in the app. The backend parser, B-gate (`PublicRecordsUnparseableError`),
 * dense + sparse extractors, and `/api/public-records/*` endpoints all
 * remain functional on disk — they're just unreachable from the UI when
 * this flag is `false`. Flip to `true` to fully restore the feature.
 *
 * Why hidden: the product positioning is now "upload your own trial
 * balance" rather than "scrape a competitor from listafirme.ro". The
 * public-records path will return as a separate feature when the
 * positioning supports it.
 */
export const PUBLIC_RECORDS_ENABLED = false as boolean;

/**
 * Hides the Decisions and Alerts nav entries, and route-guards the
 * corresponding pages, redirecting any direct hit to /dashboard (with
 * the active ?period= preserved). Components, routes, and backend
 * endpoints all remain functional on disk — they are simply unreachable
 * from the visible UI while this flag is `false`. Flipping to `true`
 * restores both surfaces fully with no other change.
 *
 * Why hidden: the user is consolidating the decision-support surface
 * into the new Ask CFO AI universal chat tab. Decisions and Alerts
 * will return once their UX is folded into the chat-first flow.
 */
export const DECISIONS_ALERTS_ENABLED = false as boolean;

/**
 * F3.16-3b.6 — Consumer cutover routing flag. When `true`, the
 * `canonicalMetrics` hub prefers `statements.assembled_canonical_v1.
 * methodology.ebitda.reported` (the YAML methodology layer) over
 * `assembled_pl.ebitda_statutory` (the legacy in-code field) for
 * the headline Reported EBITDA value consumed by every surface:
 * Dashboard KPI tile, ComprehensiveReport KPI grid, Opus briefing
 * display, Valuation, Chat workspace snapshot, Export report.
 *
 * Default `true` because F4.2-PARITY (per ADR Lock #8 Reference
 * Appendix) hard-locks the methodology field byte-identical to the
 * legacy field — 24/24 fixture-variant cells match to the cent
 * (8 fixtures × 3 HARD variants on 2026-05-26). The cutover is a
 * no-op behaviorally; flipping the flag is the single revert path
 * if any downstream consumer surfaces a regression we missed.
 *
 * The original 3b.6 plan §7 envisioned per-surface flags
 * (`F36_CUTOVER_DASHBOARD_TILE`, `F36_CUTOVER_PL_TAB`, etc.). One
 * flag at the hub replaces that whole table because every consumer
 * routes through `canonicalMetrics.ts` — a hub-level flip simul-
 * taneously cuts over every surface, and a hub-level revert backs
 * out the entire migration. This trade is sound ONLY because
 * F4.2-PARITY HARD guarantees value identity; if a future variant
 * needs surface-by-surface migration with possibly-different
 * values, the per-surface flag scheme should be re-introduced.
 *
 * Removal horizon: F4.7 (2026-11-23) — when the legacy in-code
 * fields are deleted, the fallback branch in `canonicalMetrics.ts`
 * collapses and this flag is no longer needed.
 */
export const F36_CUTOVER_METRICS_HUB = true as boolean;
