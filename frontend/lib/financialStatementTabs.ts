// Tab visibility + URL sync for the /dashboard route.
//
// Source-of-truth: the set of `DocumentType` values currently loaded — either
// derived from the active in-memory sample, OR from the persisted documents
// the user uploaded via /upload. Each tab declares which types unlock it.
// Tabs whose unlock set is empty are hidden — we never render disabled stubs.

export type DocumentType =
  | "bilant"
  | "pl"
  | "cash_flow"
  | "trial_balance"
  | "annual_report"
  | "invoice_register"
  | "invoice_single"
  | "bank_statement";

export type TabId =
  | "overview"
  | "pl"
  | "balance_sheet"
  | "cash_flow"
  | "ratios"
  | "valuation"
  | "risks"
  | "recommendations"
  | "export";

export interface TabSpec {
  id: TabId;
  label: string;
  /** Render order when multiple tabs are visible. Lower = earlier. */
  order: number;
}

// Top tab row — 9 entries. P&L, Balance Sheet, Cash Flow replace the
// single "Financial statements" tab so each statement gets its own
// top-level surface. Customers / Payments / Margin / VAT removed —
// non-FMCG companies don't benefit from them; the relevant signals
// (margin metrics, VAT compliance) surface elsewhere (Overview KPI
// strip, Recommendations).
// NOTE: "overview" is intentionally NOT listed here (2026-07-25) — the
// Overview tab TRIGGER was removed from the tab bar. `overview` stays a valid
// TabId and the routing default (resolveActiveTab) still resolves to it, so its
// TabsContent (valuation hero + the State A upload surface) remains the landing
// view beneath the always-visible KPI grid — there's just no chip for it.
// `label` values are i18n KEYS since the 2026-08-04 i18n pass — resolve
// with t(tab.label) at render time (see FinancialStatements' tab bar).
export const TAB_SPECS: TabSpec[] = [
  { id: "pl",              label: "tabs.pl",            order: 2 },
  { id: "balance_sheet",   label: "tabs.balance_sheet", order: 3 },
  { id: "cash_flow",       label: "tabs.cash_flow",     order: 4 },
  { id: "ratios",          label: "tabs.ratios",        order: 5 },
  { id: "valuation",       label: "tabs.valuation",     order: 6 },
  { id: "risks",           label: "tabs.risks",         order: 7 },
  // "recommendations" trigger removed 2026-07-25 (its notes surface inside the
  // statement tabs' "Notes & recommendations" sections). The TabsContent + the
  // TabId stay valid so nothing that references them breaks.
  { id: "export",          label: "tabs.export",        order: 9 },
];

/**
 * Per master-prompt Phase F: every tab is ALWAYS visible. Tabs that don't
 * apply for the current document set render in a disabled state with a
 * tooltip explaining what's needed to enable them. This makes the product
 * surface its full capability surface to the user, even before they've
 * uploaded anything — a key cognitive cue for "this app does much more
 * than what you're seeing right now."
 */
export type TabState = Record<TabId, boolean>;

/**
 * Compute which tabs are ENABLED given the set of document types currently
 * available. Disabled tabs still render — see callers for the disabled
 * styling + tooltip.
 *
 *   • Overview / Export                              — always enabled
 *   • Financial statements / Ratios / Recommendations — bilant | pl | trial_balance | annual_report
 *   • Valuation                                       — bilant + pl
 *   • Risks & credit                                  — bilant | pl | trial_balance
 *   • Customers                                       — invoice_register | invoice_single
 *   • Payments / VAT                                  — invoice_register
 *   • Margin                                          — invoice_register, OR invoices + pl (allocated mode)
 */
export function tabEnabled(types: Set<DocumentType>): TabState {
  const has = (...ts: DocumentType[]) => ts.some((t) => types.has(t));
  const hasFinancials = has("bilant", "pl", "trial_balance", "annual_report");
  // No data at all → State A. Recommendations stays clickable so the user
  // can preview the empty-state CTA.
  const noData = types.size === 0;

  return {
    overview:        true,
    pl:              hasFinancials,
    balance_sheet:   hasFinancials,
    cash_flow:       hasFinancials,
    ratios:          hasFinancials,
    valuation:       has("bilant", "pl") || has("trial_balance", "annual_report"),
    risks:           has("bilant", "pl", "trial_balance"),
    recommendations: hasFinancials || noData,
    export:          true,
  };
}

/**
 * Backwards-compatible alias. The `visibility` model from Phase 2 has been
 * superseded by `tabEnabled` — we still expose this name so older callers
 * compile, but the semantics are now "is this tab enabled" not "should it
 * render at all".
 *
 * @deprecated use tabEnabled(types) directly.
 */
export const tabVisibility = tabEnabled;

/**
 * Returns ALL 11 tabs in render order. Use `tabEnabled(types)[tab.id]` to
 * decide whether each one should be active or disabled.
 */
export function allTabs(): TabSpec[] {
  return [...TAB_SPECS].sort((a, b) => a.order - b.order);
}

/**
 * Coerce a `?tab=` query value to a valid TabId, with fallback to overview
 * when the value is missing/unrecognized OR when the requested tab isn't
 * currently enabled. Also redirects legacy tab slugs from the old 11-tab
 * layout (`statements`, `customers`, `payments`, `margin`, `vat`) to the
 * sensible new home so bookmarks keep working:
 *   statements → pl           (most relevant landing of the old combined tab)
 *   customers  → balance_sheet (receivables live there)
 *   payments   → cash_flow
 *   margin     → ratios
 *   vat        → balance_sheet (tax payables live there)
 */
const LEGACY_TAB_MAP: Record<string, TabId> = {
  statements: "pl",
  customers:  "balance_sheet",
  payments:   "cash_flow",
  margin:     "ratios",
  vat:        "balance_sheet",
};
export function resolveActiveTab(
  raw: string | null,
  enabled: TabState,
): TabId {
  const valid = TAB_SPECS.map((t) => t.id);
  let requested: TabId;
  if (raw && (valid as string[]).includes(raw)) {
    requested = raw as TabId;
  } else if (raw && LEGACY_TAB_MAP[raw]) {
    requested = LEGACY_TAB_MAP[raw];
  } else {
    // Default landing is P&L now (2026-07-25) — the Overview trigger was
    // removed. When there's no data, P&L is disabled and we fall through to
    // "overview" below, whose TabsContent still holds the State A upload
    // surface.
    requested = "pl";
  }
  return enabled[requested] ? requested : "overview";
}

/**
 * Human-readable hint for the disabled-tab tooltip. Every tab gets the same
 * generic CTA at the end; the per-tab prefix tells the user *what* is missing.
 */
export function disabledHint(
  tab: TabId,
  t: (key: string) => string,
): string {
  const prefixKey: Record<TabId, string | null> = {
    overview:        null,
    pl:              "tabs.hint_pl",
    balance_sheet:   "tabs.hint_balance_sheet",
    cash_flow:       "tabs.hint_cash_flow",
    ratios:          "tabs.hint_ratios",
    valuation:       "tabs.hint_valuation",
    risks:           "tabs.hint_risks",
    recommendations: "tabs.hint_recommendations",
    export:          null,
  };
  const key = prefixKey[tab];
  return `${key ? t(key) : ""}${t("tabs.hint_suffix")}`;
}
