// F5.0 — Concept schema (type-only).
//
// This file ships during the F5.0 scoping session (2026-06-05) ahead of
// Phase 1 launch. Purpose: lock the Concept interface shape so Phase 1
// builds against a known contract rather than redesigning it under time
// pressure. Zero runtime cost — type definitions only.
//
// i18n shape: every user-visible translatable field is `{ en, ro }`.
// Romanian is the launch locale for Scandia + BVB customers; English is
// the second locale. Phase 4 may extend with additional languages by
// expanding the LocalizedString type without touching call sites.
//
// Why a leading underscore in the filename: keeps it visually separated
// from concept data files (seed.ts, profitability.ts, etc.). The barrel
// (index.ts) imports types from here; concept files import the Concept
// type from here.
//
// Lock #11 anchor: this file IS the shared hub. No per-page learning
// component is allowed to define its own concept shape — they all consume
// `Concept` from this file (typically re-exported via index.ts).
//
// Lock #12 readiness: the interpretation interface includes both
// getSentiment (classifier) and getNarrative (one-liner). Phase 1's
// verification gate requires each concept to ship discriminating
// positive + negative test values when these functions are present —
// the optional `?` on `interpretation` is for "value-only" concepts
// (e.g. raw line items like Revenue) that don't classify.

/** All translatable user-visible strings. Add languages by extending
 *  this type; call sites won't break because both fields stay required
 *  for the launch locales. Add fallback handling in `useConcept` if a
 *  future locale doesn't have full coverage. */
export interface LocalizedString {
  en: string;
  ro: string;
}

/** Top-level grouping shown as a badge in the Layer 2 popover header
 *  and as a section header in Phase 5's `/learn` route. Adding a new
 *  category here forces every concept file to import it — that's
 *  intentional, prevents drift from typos. */
export type ConceptCategory =
  | "Profitability"
  | "Liquidity"
  | "Working Capital"
  | "Leverage & Solvency"
  | "Coverage"
  | "Efficiency"
  | "Valuation"
  | "Cash Flow"
  | "Risk & Credit"
  | "Romanian RAS"
  // F5.0 Step 1 (CFO AI Learn) — new top-level surfaces. Additive only,
  // existing concepts keep their current category labels. New concepts
  // (benchmark gaps, SKU-level inventory metrics, public-company
  // market-data fields, individual RAS source-account explanations)
  // get their own home so the glossary + page-guide flows can group
  // them coherently.
  | "Benchmark"
  | "Inventory"
  | "Public Company"
  | "Source Account";

/** Sentiment classification — drives color tint on the rendered value
 *  AND the dot indicator in the popover narrative. Three-state by design;
 *  binary good/bad oversimplifies financial metrics. */
export type Sentiment = "positive" | "negative" | "neutral";

/** Industry / peer benchmark band used by the BenchmarkMicroBar and the
 *  interpretation functions. Values are in the metric's native unit
 *  (decimal fraction for percentages, raw ratio for ratios, count for
 *  days). The component handles display formatting. */
export interface ConceptBenchmark {
  p25: number;
  median: number;
  p75: number;
  /** Free-form attribution — shown in micro-bar header. e.g. "RAS food mfg".
   *  Optional: when omitted the micro-bar falls back to a generic "industry
   *  benchmark" label. Phase 4 will populate this per-sector from the
   *  Damodaran + RAS calibration set. */
  source?: string;
}

/** Runtime context threaded into interpretation functions. Phase 1 fills
 *  only `benchmark`; Phase 2+ adds sector and periodsAvailable. All
 *  fields optional — concepts must handle the missing-context case via
 *  hard-coded defaults. */
export interface ConceptContext {
  benchmark?: ConceptBenchmark;
  /** Number of historical periods available — used by Phase 2 trend
   *  phrasing ("two periods of decline"). */
  periodsAvailable?: number;
  /** Free-form sector label hint. Concepts may use to vary narrative. */
  sector?: string;
  /** F5.0 Phase 1.5 — Structured numeric snapshot of the active period.
   *  Populated by ReportingContextProvider in the active dashboard. When
   *  present, `computation()` functions read children values from here
   *  to render structured InteractiveFormula tokens; when absent, the
   *  formula gracefully degrades to inlineFormula plain text. */
  metrics?: ReportingMetrics;
  /** F5.0 Phase 1.5 — Currency code for value formatting. */
  currency?: string;
  /** F5.0 Phase 1.5 — Locale code (en | ro) for narrative + name. */
  locale?: "en" | "ro";
}

/** F5.0 Phase 1.5 — Canonical snapshot of the active period's numeric
 *  surface, exposed via ReportingContextProvider. Every field is
 *  optional — consumers must handle missing values gracefully. */
export interface ReportingMetrics {
  // P&L
  revenue?: number;
  cogs?: number;
  grossProfit?: number;
  opex?: number;
  ebit?: number;
  ebitda?: number;
  depreciation?: number;
  amortization?: number;
  netFinancialResult?: number;
  interestExpense?: number;
  pretaxProfit?: number;
  incomeTax?: number;
  netProfit?: number;
  // Balance Sheet
  totalAssets?: number;
  currentAssets?: number;
  nonCurrentAssets?: number;
  cash?: number;
  inventory?: number;
  receivables?: number;
  ppe?: number;
  totalEquityAndLiab?: number;
  currentLiabilities?: number;
  accountsPayable?: number;
  shortTermDebt?: number;
  longTermDebt?: number;
  totalDebt?: number;
  shareholdersEquity?: number;
  shareCapital?: number;
  retainedEarnings?: number;
  // Cash Flow
  operatingCashFlow?: number;
  workingCapitalChanges?: number;
  capex?: number;
  investingCashFlow?: number;
  ltDebtDrawdowns?: number;
  ltDebtRepayments?: number;
  dividendsPaid?: number;
  financingCashFlow?: number;
  netChangeInCash?: number;
  openingCash?: number;
  closingCash?: number;
  // Valuation
  enterpriseValue?: number;
  equityValue?: number;
  evEbitdaMultiple?: number;
  freeCashFlow?: number;
  wacc?: number;
  // Risk
  altmanZ?: number;
  compositeCreditScore?: number;
  // Optional source-account trace per metric — for leaf concepts.
  // Map from concept key → list of source accounts.
  accountTraces?: Record<string, AccountTrace[]>;
}

/** F5.0 Phase 1.5 — Source account entry for the bottom of the
 *  recursion chain. Pin-points back to the trial balance. */
export interface AccountTrace {
  /** RAS account code, e.g. "701" or "1621". */
  code: string;
  /** Display label (Romanian or English, depending on locale). */
  label: string;
  /** Period-end amount in source currency. */
  amount: number;
  /** Side hint — debit ("D") or credit ("C"). */
  side?: "D" | "C";
  /** Optional override for the deep-link route. Defaults to
   *  `/financials?account=<code>`. Used when a non-RAS source (e.g.
   *  public-company dataset row) wants to drive the user elsewhere. */
  route?: string;
}

// ─── F5.0 Step 1 (CFO AI Learn) — SourceTrace union ────────────────────
//
// Every leaf concept (a metric that doesn't decompose into other metrics
// — Revenue, Cash, Market Cap, Stock Price, etc.) should be able to
// say "I came from HERE", where HERE may be:
//   · the Romanian trial balance (a list of RAS accounts)
//   · a financial statement line (PL/BS/CF row, not necessarily tied to
//     a single account — useful when an aggregate is the meaningful unit)
//   · a public-company dataset (NASDAQ Data Link, SEC filings, BVB, or a
//     simpler public-summary source)
//   · invoice / inventory rows (per-SKU, per-customer drill-down)
//   · a pure calculation (the value was derived from other metrics —
//     the popover already shows that via `computation`, but
//     `sourceType: "calculated"` is the canonical answer to "what's the
//     source?" for derived values)
//   · manual input (operator-entered, e.g. industry override)
//
// Discriminated union: every variant carries `sourceType` plus its own
// payload. Consumers branch on `sourceType` to render the right block
// (SourceAccountLink vs SourceDocumentLink vs plain "Calculated" note).
//
// Importantly: `SourceTrace` does NOT REPLACE the existing
// `staticSourceAccounts(key)` lookup or `AccountTrace[]` on the
// FormulaSpec — both stay, both work. `sourceTrace` is an OVERRIDE the
// concept can opt into when the static lookup is wrong for its
// situation (e.g. public-company `marketCap` should NOT route to a
// fake RAS account; it should route to the NASDAQ fundamentals page).

/** F5.0 Step 1 — Discriminated union of where a concept's value came from. */
export type SourceTrace =
  | {
      sourceType: "trial_balance_account";
      accounts: AccountTrace[];
      /** Optional confidence 0–1 — when the engine flagged extraction
       *  with low confidence, the popover surfaces a hint. */
      confidence?: number;
    }
  | {
      sourceType: "financial_statement_line";
      /** "pl" | "bs" | "cf" | "ratios" */
      statement: "pl" | "bs" | "cf" | "ratios";
      /** Bucket key on the statement, e.g. "ebitda", "currentAssets". */
      bucket: string;
      /** Display label for the row. */
      label?: string;
      /** Optional route override; default deep-links into FinancialStatements. */
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "public_company_dataset";
      /** Vendor of the dataset — informs the badge + the route to docs. */
      vendor: "nasdaq" | "sec" | "bvb" | "public_summary";
      /** Free-form dataset / table label, e.g. "SHARADAR/SF1", "10-K". */
      dataset: string;
      /** Period or as-of date — shown to the user so they understand
       *  the data's freshness. */
      asOf?: string;
      /** Optional deep link to the upstream record. */
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "nasdaq";
      dataset: string;
      asOf?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "sec";
      filing: string;
      asOf?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "bvb";
      issuer: string;
      asOf?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "public_summary";
      provider: string;
      asOf?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "invoice";
      /** Invoice id + label. Routes to /invoices?id=… when wired. */
      invoiceId: string;
      label?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "inventory";
      /** SKU / category id. Routes to /products?sku=… when wired. */
      skuId: string;
      label?: string;
      route?: string;
      confidence?: number;
    }
  | {
      sourceType: "calculated";
      /** Plain-text recap of what the value was derived from. The
       *  computed formula tokens already render via InteractiveFormula;
       *  this string is a short human prose label, e.g. "Derived from
       *  EBIT, depreciation, and amortization." */
      derivedFrom: string;
      confidence?: number;
    }
  | {
      sourceType: "manual_input";
      /** Who set it + when, when available. */
      who?: string;
      at?: string;
      confidence?: number;
    };

/** F5.0 Phase 1.5 — Token-stream description of a formula. Returned by
 *  `Concept.computation`. The token stream is rendered by the
 *  InteractiveFormula component as a sequence of (recursively
 *  tappable) values, operators, and literals. */
export interface FormulaSpec {
  result: { value: number; format: ValueFormat; conceptKey?: string };
  layout: "inline" | "fraction" | "stacked";
  tokens: FormulaToken[];
  /** Optional source-account trace for "leaf" concepts that don't have
   *  a sub-formula (Revenue → list of source accounts in 70x). */
  trace?: { accounts: AccountTrace[] };
}

export type ValueFormat = "currency" | "percentage" | "ratio" | "days" | "score" | "raw";

export type FormulaToken =
  | { type: "value"; value: number; conceptKey: string; label?: string; format?: ValueFormat }
  | { type: "operator"; op: "+" | "−" | "×" | "÷" | "=" }
  | { type: "literal"; text: string }
  | { type: "group_open" }
  | { type: "group_close" };

/** The atomic learning unit. Phase 1 ships 5 (the seed); Phase 4 expands
 *  to 50-80 spread across category files. Existing call sites reference
 *  `key` as a string literal — once published, `key` is forever stable.
 *  Renaming silently breaks consumers; deprecate via a `replacedBy`
 *  field instead if needed (Phase 4 work). */
export interface Concept {
  /** Stable string identifier. Snake_case convention. Never renamed
   *  once published. */
  key: string;

  /** Display name shown in popover header + concept browser. */
  name: LocalizedString;

  /** Top-level category. See ConceptCategory above. */
  category: ConceptCategory;

  /** One-sentence definition shown in Layer 2 popover body. Plain prose,
   *  reading age "smart business user" — NOT a CFA charterholder.
   *  Target length: 80-150 characters per language. */
  shortDefinition: LocalizedString;

  /** Optional inline formula, monospace rendered. Math notation is
   *  universal so no i18n needed. Keep ≤ 60 chars to fit the 320px
   *  popover. Example: "EBITDA ÷ Revenue × 100" */
  inlineFormula?: string;

  /** Optional interpretation engine. Required for "metric" concepts
   *  (ratios, percentages, days). Optional for "value" concepts (raw
   *  line items like Revenue or COGS — these have no good/bad
   *  classification on their own).
   *
   *  Lock #12: when present, each function must discriminate. Phase 1
   *  verification injects positive + negative synthetic values and
   *  asserts getSentiment returns different sentiments.
   *
   *  F5.0 Step 1 (CFO AI Learn): `goodRange`, `warningRange`, `badRange`
   *  are new optional explicit thresholds. When present, the popover
   *  renders a small "what good/bad looks like" pill row above the
   *  narrative — independent of the live `getSentiment` classification.
   *  Useful for ratios where the bands are well-known industry rules
   *  of thumb. Values in the metric's native unit (decimal for %, raw
   *  number for ratios, count for days). Tuples are
   *  [min, max] inclusive. */
  interpretation?: {
    getSentiment: (value: number, ctx?: ConceptContext) => Sentiment;
    getNarrative: (value: number, ctx?: ConceptContext) => string;
    goodRange?: [number, number];
    warningRange?: [number, number];
    badRange?: [number, number];
  };

  /** Related concept keys for Layer 3 navigation grid (Phase 2). Stays
   *  required (not optional) so every concept opts into the hyperlinked-
   *  understanding pattern. Empty array `[]` is acceptable for terminal
   *  concepts that don't link anywhere else. */
  related: string[];

  /** Optional static benchmark band rendered by BenchmarkMicroBar in the
   *  Layer 2 popover. Used for ratios + days metrics. Skipped for raw
   *  value concepts (revenue, cogs) where a percentile band would be
   *  meaningless on absolute amounts.
   *  Phase 1 keeps benchmarks generic; Phase 4 will override per-industry
   *  via `useConcept`'s context wiring. */
  benchmark?: ConceptBenchmark;

  /** Optional textbook-level reference body shown in Layer 3's "Learn
   *  more" section. Markdown allowed. Phase 2 wires the renderer;
   *  Phase 4 fills these in for the full library. */
  longFormReference?: LocalizedString;

  /** F5.0 Phase 1.5 — Structured computation. When present, the
   *  popover renders the formula as recursively-tappable
   *  InteractiveFormula tokens instead of plain inlineFormula text.
   *  Each token of type "value" references another concept key, so
   *  the user can tap to drill down. Leaf concepts (Revenue, COGS, raw
   *  line items) return a spec with empty `tokens` and a `trace.accounts`
   *  array pointing to source RAS accounts.
   *
   *  The function is invoked once per popover open with the active
   *  ReportingMetrics + the popover's value. It MUST be pure — same
   *  inputs always produce same FormulaSpec. */
  computation?: (ctx: ConceptContext, value: number) => FormulaSpec | null;

  /** F5.0 Step 1 (CFO AI Learn) — Plain-English explanation, separate
   *  from `shortDefinition`. Where `shortDefinition` is finance-grade
   *  prose ("the closest single-number read on cash generated by the
   *  operating business…"), `plainEnglish` is reading-age-12 prose
   *  ("how much money the business makes from its day-to-day operations,
   *  before paying interest or tax"). Surfaced in Guided learning
   *  mode + the page guide overlay; falls back to `shortDefinition`
   *  when missing. Both locales optional individually (the resolver
   *  falls back en → ro → shortDefinition). */
  plainEnglish?: LocalizedString;

  /** F5.0 Step 1 (CFO AI Learn) — Where the value came from. When
   *  present, the popover renders a `SourceTrace`-shaped block and
   *  prefers it over the static `staticSourceAccounts(key)` lookup
   *  (the static lookup stays as a fallback for concepts that don't
   *  define `sourceTrace`). Used by leaf concepts that need a non-RAS
   *  source — public-company market data routes to NASDAQ Fundamentals,
   *  per-SKU metrics route to the SKU drawer, manual inputs surface
   *  who set them.
   *
   *  Function (not a static value) so concepts can branch on the active
   *  ReportingMetrics — e.g. a concept might route to trial balance
   *  when the active period is private, and to NASDAQ when it's a
   *  public-company ticker. */
  sourceTrace?: (ctx: ConceptContext, value: number) => SourceTrace | null;
}
