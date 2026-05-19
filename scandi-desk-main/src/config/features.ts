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
