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
  | "statements"
  | "ratios"
  | "customers"
  | "payments"
  | "margin"
  | "vat"
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

export const TAB_SPECS: TabSpec[] = [
  { id: "overview",        label: "Overview",             order: 1  },
  { id: "statements",      label: "Financial statements", order: 2  },
  { id: "ratios",          label: "Ratios",               order: 3  },
  { id: "customers",       label: "Customers",            order: 4  },
  { id: "payments",        label: "Payments",             order: 5  },
  { id: "margin",          label: "Margin",               order: 6  },
  { id: "vat",             label: "VAT",                  order: 7  },
  { id: "valuation",       label: "Valuation",            order: 8  },
  { id: "risks",           label: "Risks & credit",       order: 9  },
  { id: "recommendations", label: "Recommendations",      order: 10 },
  { id: "export",          label: "Export",               order: 11 },
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
  const hasInvoices = has("invoice_register", "invoice_single");
  const hasPL = has("pl");
  const hasFinancials = has("bilant", "pl", "trial_balance", "annual_report");
  // No data at all → State A. Recommendations stays clickable so the user
  // can preview the empty-state CTA. Once invoice-only data lands (Aurelius),
  // Recommendations disables because the engine can't derive recs from
  // invoice register alone.
  const noData = types.size === 0;

  return {
    overview:        true,
    statements:      hasFinancials,
    ratios:          hasFinancials,
    valuation:       has("bilant", "pl"),
    risks:           has("bilant", "pl", "trial_balance"),
    customers:       has("invoice_register", "invoice_single"),
    payments:        has("invoice_register"),
    margin:          has("invoice_register") || (hasInvoices && hasPL),
    vat:             has("invoice_register"),
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
 * currently enabled (e.g. ?tab=payments with no invoices loaded).
 */
export function resolveActiveTab(
  raw: string | null,
  enabled: TabState,
): TabId {
  const valid = TAB_SPECS.map((t) => t.id);
  const requested = raw && (valid as string[]).includes(raw) ? (raw as TabId) : "overview";
  return enabled[requested] ? requested : "overview";
}

/**
 * Human-readable hint for the disabled-tab tooltip. Every tab gets the same
 * generic CTA at the end; the per-tab prefix tells the user *what* is missing.
 */
export function disabledHint(tab: TabId): string {
  const prefix: Record<TabId, string> = {
    overview:        "",
    statements:      "Needs a balance sheet, P&L, or trial balance — ",
    ratios:          "Needs a balance sheet, P&L, or trial balance — ",
    valuation:       "Needs a balance sheet AND P&L — ",
    risks:           "Needs a balance sheet, P&L, or trial balance — ",
    customers:       "Needs an invoice register — ",
    payments:        "Needs an invoice register — ",
    margin:          "Needs an invoice register — ",
    vat:             "Needs an invoice register — ",
    recommendations: "Needs a balance sheet, P&L, or trial balance — ",
    export:          "",
  };
  return `${prefix[tab]}upload a financial statement or load a sample to enable this view.`;
}
