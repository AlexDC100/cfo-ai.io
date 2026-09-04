// THE CAPSULE — FACT INDEX (Part A, tier 1 of 3).
//
// Built ONCE when a period loads, held in memory, and read by the Tier-0
// resolver in microseconds. It is the thing that makes an answer arrive
// before the model does: by the time the user finishes typing "total
// assets", the answer is already a map lookup away.
//
// ── Where the numbers come from ───────────────────────────────────────
//
// Every figure here is a RESOLVED FACT with provenance. Nothing is
// computed off a raw envelope, nothing is guessed from magnitude:
//
//   BALANCE SHEET  `servedFacts.factsFrom(statements)` — THE sanctioned
//                  frontend gateway (docs/CANONICAL_BS_V2_CONTRACT.md).
//                  Totals, the current/non-current splits, working
//                  capital and the drift all come off its accessors;
//                  this module never touches `canonical_bs.totals`, and
//                  `scripts/check_import_boundary.py` enforces that.
//   STATEMENT LINES  the served canonical rows, verbatim, with their own
//                  account codes as provenance.
//   P&L            `assembled_canonical_v1.methodology` — the SAME two
//                  paths the engine's own gateway reads
//                  (`engine.serving.facts.FactsGateway.revenue` reads
//                  `totals.revenue_net`; `.ebitda` reads
//                  `ebitda.reported`), including the same P&L-placed
//                  reconciliation-delta rule.
//   RATIOS         engine `calculated_metrics` when the caller supplies
//                  them; otherwise derived from NATIVE same-period
//                  operands and stamped with the derivation.
//   FINDINGS       `factsCited` / `factUnits` — the engine's own numbers
//                  with the engine's own declared units.
//
// ── Why P&L reads `methodology`, not `assembled_pl` ───────────────────
//
// `assembled_pl` is the obvious source. It is not the AUTHORITATIVE one.
// The engine's own Capsule tool lane resolves `revenue` through
// `FactsGateway.revenue` → `methodology.totals.revenue_net` and `ebitda`
// through `FactsGateway.ebitda` → `methodology.ebitda.reported`. Reading
// a different object would mean Tier 0 and Tier 1/2 could answer the
// same question about the same period with two different numbers.
//
// On today's engine the two objects AGREE on the corpus periods — and
// they have not always. This repo still carries the F3.8 regression
// baseline for the same company (`country_packs/ro_romania/fixtures/
// regression_baselines/carniprod_fy2025.json`), where `assembled_pl`
// reports revenue 86,217,270.73 and EBITDA −3,122,134.74 against the
// methodology block's 99,424,740.16 and 9,588,744.57. Two views of one
// period that have diverged by 15% and by a sign change inside this
// repo's own history are not interchangeable sources. So the rule is
// "read what the engine gateway reads", and `capsuleFactIndex.test.ts`
// asserts the CONVERGENCE — the day the two objects part company again,
// that gate fails instead of the Capsule quietly contradicting itself.
//
// ── Four laws ─────────────────────────────────────────────────────────
//
// F1  ABSENT IS NOT ZERO. A concept the period does not carry produces
//     NO FactRef. There is no zero-filled slot anywhere in this file.
// F2  UNITS ARE DECLARED, NEVER INFERRED. Every FactRef carries its own
//     unit; a consumer never has to guess money from magnitude. The
//     vocabulary mirrors `engine.api._ratio_units` exactly.
// F3  NATIVE-UNIT MATH. A derived ratio divides two operands of the same
//     period in their SOURCE currency, so the result is dimensionless
//     and invariant under the display-currency dial. Display conversion
//     never participates, and a zero or absent denominator refuses.
// F4  DETERMINISTIC. No clock, no randomness, no storage, no fetch. The
//     same snapshot always builds the same index in the same order.

import type { Statements, CanonicalBsRow, CanonicalBsStatus } from "./financialReport";
import { factsFrom } from "./servedFacts";
import { foldQuery } from "./capsuleRouter";

// ══════════════════════════════════════════════════════════════════════
// THE PUBLISHED CONTRACT
// ══════════════════════════════════════════════════════════════════════

/** Unit vocabulary. Mirrors `engine.api._ratio_units` (UNIT_MONEY /
 *  UNIT_RATIO / UNIT_PERCENT / UNIT_DAYS / UNIT_COUNT / UNIT_SCORE) so a
 *  Capsule figure and a finding figure describe themselves identically.
 *  There is deliberately no "unknown" member: a fact whose unit cannot
 *  be declared is not built. */
export type FactUnit = "money" | "ratio" | "percent" | "days" | "count" | "score";

/** How a FactRef was produced. Additive to the published minimum; a
 *  consumer that only reads the contracted fields is unaffected. */
export type FactSource =
  | "served_bs"        // servedFacts gateway accessor
  | "statement_line"   // a served canonical_bs row, verbatim
  | "methodology"      // assembled_canonical_v1.methodology
  | "engine_metric"    // engine calculated_metrics, supplied by the caller
  | "derived"          // native-unit arithmetic over same-period operands
  | "finding"          // a finding's factsCited entry
  | "period_meta";     // a property of the index itself (period count …)

/** THE published fact shape. Every other lane imports this and may
 *  assume it from minute one. Fields below `periodLabel` are ADDITIVE —
 *  all optional, so a hand-built literal in another lane's test still
 *  type-checks. */
export type FactRef = {
  /** Stable name. Reuses the engine's metric vocabulary
   *  (`_capsule_tools.METRICS`) wherever one exists, so Tier 0 and the
   *  model tool lane name the same thing. */
  factKey: string;
  /** Presentation label. Engine-supplied verbatim for statement lines. */
  label: string;
  value: number;
  unit: string;
  /** Money only. Never set on a dimensionless fact (the unit law). */
  currency?: string;
  provenance?: { docId?: string; cell?: string; account?: string };
  periodId: string;
  periodLabel: string;

  // ── additive ────────────────────────────────────────────────────────
  /** i18n key when the label is translatable (`capsule.metric.<name>`
   *  for metrics, the engine's own `bs.row.<id>` for statement lines). */
  labelKey?: string;
  source?: FactSource;
  /** Account codes behind the figure, when the served row names them. */
  accountCodes?: readonly string[];
  /** Set on `source: "derived"`: what was divided by what. */
  derivation?: { op: "ratio" | "share"; operands: readonly string[] };
  /** True when `factKey` is declared money in the engine's own fact
   *  vocabulary (`_ratio_units._MONEY_FACTS`). A consumer that must not
   *  cite an undeclared name filters on this. */
  engineDeclared?: boolean;
  /** The served canonical row's own SECTION (`current_assets`,
   *  `equity`, …), carried verbatim on `source: "statement_line"` facts
   *  and set on nothing else.
   *
   *  It exists for exactly one consumer — `classShareOf`, which answers
   *  "how big is this line inside its own class". Without it that share
   *  would have to be computed against a total the consumer picked,
   *  which is a different claim: the engine decided which section a row
   *  belongs to, and a second opinion assembled on the client would
   *  disagree with the balance sheet the reader can open. */
  section?: string;
  /** The ENGINE's own subtotal for that section (`CanonicalBs.sections
   *  [].subtotal`), carried verbatim beside it.
   *
   *  Deliberately NOT a client-side sum of the rows in the section: the
   *  served subtotal is what the balance sheet prints, and re-adding the
   *  rows here would produce a second number that disagrees with it the
   *  first time the engine files a row somewhere the client did not
   *  expect. Set only when the served subtotal is finite and non-zero —
   *  a share against nothing is unanswerable, not 100%. */
  sectionTotal?: number;
};

/** One period as the index knows it. */
export interface FactIndexPeriod {
  periodId: string;
  periodLabel: string;
  /** Native (source) currency. Ratios never cross it. */
  currency: string;
  entity: string;
  /** Served BS status — the honest answer to "is it balanced". */
  bsStatus: CanonicalBsStatus | null;
  needsReview: boolean;
  /** Engine diagnosis CODES (D0–D8) when the serving carries them.
   *  Codes only: the `detail` strings carry figures, and a figure
   *  reaches the DOM through the money path or not at all. */
  diagnosisCodes: readonly string[];
  /** How many facts this period contributed. */
  factCount: number;
}

export interface FactIndex {
  /** Every fact, active period first, then the rest in snapshot order. */
  facts: readonly FactRef[];
  /** factKey → its refs, one per period, in period order. */
  byKey: ReadonlyMap<string, readonly FactRef[]>;
  /** Folded search term → the factKeys it names. */
  termIndex: ReadonlyMap<string, readonly string[]>;
  periods: readonly FactIndexPeriod[];
  activePeriodId: string | null;
}

/** One period's inputs. `statements` is the `/api/period` blob verbatim. */
export interface CapsuleFactPeriodInput {
  periodId: string;
  /** The fiscal-period label ("December 2025"). Empty means UNLABELLED —
   *  a compare against it refuses rather than guessing which months it
   *  covers, mirroring `_capsule_tools.compare_periods`. */
  periodLabel: string;
  statements: Statements;
  /** Engine `calculated_metrics` keyed by name. Preferred over local
   *  derivation for every ratio that has an engine equivalent. */
  metrics?: Record<string, number | null> | null;
  /** Finding seeds — `factsCited` + `factUnits` straight off the engine
   *  finding payload. Titles are deliberately NOT read: a resolved title
   *  can carry source-currency numerals (the S1 rule). */
  findings?: readonly CapsuleFindingFactSeed[] | null;
  /** Source document id, for provenance. */
  docId?: string;
}

export interface CapsuleFindingFactSeed {
  key: string;
  ruleKey: string;
  factsCited: Record<string, number>;
  factUnits: Record<string, string>;
}

/** Periods NEWEST FIRST. The index preserves the order it is given; it
 *  never sorts by a parsed date, because a label is free text. */
export interface CapsuleFactSnapshot {
  periods: readonly CapsuleFactPeriodInput[];
  activePeriodId?: string | null;
}

export function buildFactIndex(snapshot: CapsuleFactSnapshot): FactIndex {
  const periodsIn = snapshot?.periods ?? [];
  const activeId =
    snapshot?.activePeriodId ?? (periodsIn.length ? periodsIn[0].periodId : null);

  // Active period first so `lookupFacts` and the Tier-0 resolver answer
  // about the period the user is looking at without either of them
  // encoding the rule.
  const ordered = periodsIn
    .slice()
    .sort((a, b) => {
      const aActive = a.periodId === activeId ? 0 : 1;
      const bActive = b.periodId === activeId ? 0 : 1;
      return aActive - bActive;
    });

  const facts: FactRef[] = [];
  const periods: FactIndexPeriod[] = [];

  for (const input of ordered) {
    const before = facts.length;
    const meta = buildPeriodFactsInto(facts, input);
    periods.push({ ...meta, factCount: facts.length - before });
  }

  // Period-count is a fact about the INDEX, so it is attached once, to
  // the active period, rather than per-period (which would make "how
  // many periods" return N copies of N).
  if (periods.length > 0) {
    const head = periods[0];
    facts.push({
      factKey: FACT_PERIOD_COUNT,
      label: "Periods loaded",
      labelKey: "capsule.metric.period_count",
      value: periods.length,
      unit: "count",
      periodId: head.periodId,
      periodLabel: head.periodLabel,
      source: "period_meta",
      engineDeclared: false,
    });
  }

  const byKey = new Map<string, FactRef[]>();
  for (const fact of facts) {
    const bucket = byKey.get(fact.factKey);
    if (bucket) bucket.push(fact);
    else byKey.set(fact.factKey, [fact]);
  }

  return {
    facts,
    byKey,
    termIndex: buildTermIndex(byKey),
    periods,
    activePeriodId: activeId,
  };
}

/** Facts named by any of `terms`, deduped, in a deterministic order:
 *  the order the terms were asked for, then match specificity (exact
 *  term beats prefix beats containment), then period order. */
export function lookupFacts(index: FactIndex, terms: string[]): FactRef[] {
  if (!index || !terms || terms.length === 0) return [];
  const seen = new Set<string>();
  const out: FactRef[] = [];
  for (const raw of terms) {
    for (const factKey of matchFactKeys(index, raw)) {
      for (const fact of index.byKey.get(factKey) ?? []) {
        const id = `${fact.factKey}\u0000${fact.periodId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(fact);
      }
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// Metric vocabulary
// ══════════════════════════════════════════════════════════════════════

/** Names declared MONEY by `engine.api._ratio_units._MONEY_FACTS`. A
 *  fact whose key is in here can be cited by the engine's own narrative
 *  layer without resolving to UNIT_UNKNOWN (which is a refusal, not a
 *  default). `capsuleFactIndex.test.ts` reads the Python set and asserts
 *  this mirror has not drifted. */
export const ENGINE_MONEY_FACTS: readonly string[] = Object.freeze([
  "affiliate_income",
  "bank_debt_total",
  "capex_real",
  "capitalized_construction",
  "capitalized_own_work_memo",
  "cash",
  "cash_from_operating",
  "covenant_limit",
  "cur_liab",
  "currency",
  "current_assets",
  "current_liabilities",
  "difference",
  "dividends_payable",
  "drift",
  "ebitda",
  "ebitda_cash",
  "ebitda_operating",
  "ebitda_operational",
  "ebitda_statutory",
  "enterprise_value",
  "equity",
  "equity_plus_liabilities",
  "expenses",
  "free_cash_flow",
  "fx_cash",
  "intercompany_loans",
  "market_cap",
  "net_debt",
  "net_income",
  "net_income_operating",
  "net_result",
  "price",
  "rec_provisions",
  "rental_revenue",
  "revaluation_reserves",
  "revenue",
  "scenario_result_delta",
  "share_capital",
  "total_assets",
  "total_cash",
  "total_equity",
  "total_expenses",
  "total_liabilities",
  "total_operating_revenue",
  "trade_rec",
  "working_capital",
]);

const ENGINE_MONEY_SET = new Set(ENGINE_MONEY_FACTS);

/** Result rows of a served canonical_bs, mirroring
 *  `engine.serving.facts._RESULT_ROW_IDS`. The gateway sums exactly
 *  these to produce `net_result`; the mirror is pinned by test. */
export const RESULT_ROW_IDS: readonly string[] = Object.freeze([
  "current_year_profit",
  "current_year_loss",
]);

/**
 * Sum a set of served rows and list ONLY the accounts that contributed.
 *
 * THE DEFECT THIS REPLACES. Three sites summed with `(r.amount ?? 0)` and
 * then listed accounts with a separate `flatMap` over the SAME unfiltered
 * rows. A row served with a null amount therefore contributed nothing to
 * the total while its account code still appeared on the fact's card —
 * the card naming an account that is not in the number. That is a
 * provenance jump that lands on a real account holding a real balance the
 * figure does not include, which is worse than landing nowhere.
 *
 * The filter runs ONCE and both outputs come off the same array, so the
 * two can no longer be built from different sets. `total` is null when no
 * row survived: a concept with no contributing row is absent, not zero.
 */
export function sumContributingRows(
  rows: readonly CanonicalBsRow[],
): { total: number | null; accounts: string[]; skipped: number } {
  const contributing = rows.filter(
    (r) => r && typeof r.amount === "number" && Number.isFinite(r.amount),
  );
  return {
    total:
      contributing.length > 0
        ? contributing.reduce((sum, r) => sum + (r.amount as number), 0)
        : null,
    accounts: contributing.flatMap((r) => r.account_codes ?? []),
    skipped: rows.length - contributing.length,
  };
}

export const FACT_PERIOD_COUNT = "period_count";
export const FACT_FINDING_COUNT = "finding_count";

/** The metric names the engine's Capsule tool registry exposes
 *  (`_capsule_tools.METRICS`). Tier 0 must resolve every one of these
 *  from local facts, or the instant tier is a different vocabulary from
 *  the model tier. Pinned by test against the Python registry. */
export const ENGINE_CAPSULE_METRICS: readonly string[] = Object.freeze([
  "total_assets", "total_liabilities", "equity", "equity_plus_liabilities",
  "current_assets", "current_liabilities", "working_capital",
  "net_result", "revenue", "expenses", "ebitda", "difference",
  "current_ratio", "equity_ratio", "net_margin",
]);

/** Search vocabulary, EN + RO, folded through the router's ONE
 *  normaliser. Adding a metric — or a Romanian definite-article form —
 *  is a DATA edit here plus a fixture line, never a new branch in the
 *  resolver. Romanian marks the definite article as a suffix
 *  ("numerar" → "numerarul", "profit" → "profitul"), and a stemmer that
 *  guessed at those would also happily fold words that are not
 *  inflections of each other; the inflected forms are therefore listed,
 *  the same way `capsuleRouter` lists "raportul" beside "raport". */
export const METRIC_TERMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  total_assets: ["total assets", "assets", "total asset", "activ total",
                 "total active", "active totale", "activ", "activele",
                 "activele totale"],
  total_liabilities: ["total liabilities", "liabilities", "datorii",
                      "total datorii", "datorii totale", "datoriile",
                      "datoriile totale"],
  equity: ["equity", "total equity", "capitaluri proprii", "capital propriu",
           "capitaluri", "capitaluri totale", "capitalurile proprii",
           "capitalurile"],
  equity_plus_liabilities: ["equity plus liabilities", "equity and liabilities",
                            "capitaluri si datorii", "pasiv", "total pasiv"],
  current_assets: ["current assets", "active circulante", "activ circulant",
                   "activele circulante"],
  current_liabilities: ["current liabilities", "datorii curente",
                        "datorii pe termen scurt", "datorii curente totale",
                        "datoriile curente"],
  non_current_assets: ["non current assets", "fixed assets", "active imobilizate",
                       "imobilizari", "imobilizarile"],
  non_current_liabilities: ["non current liabilities", "long term liabilities",
                            "datorii pe termen lung"],
  working_capital: ["working capital", "capital de lucru", "fond de rulment",
                    "capitalul de lucru", "fondul de rulment"],
  difference: ["difference", "drift", "imbalance", "diferenta", "dezechilibru",
               "balanced", "echilibrat", "balance check"],
  cash: ["cash", "cash and equivalents", "numerar", "disponibilitati",
         "disponibil", "bani", "lichiditati", "numerarul", "disponibilul"],
  revenue: ["revenue", "turnover", "net turnover", "sales", "top line",
            "cifra de afaceri", "venituri", "vanzari", "venit",
            "cifra de afaceri neta", "veniturile", "vanzarile"],
  expenses: ["expenses", "total expenses", "costs", "cheltuieli",
             "cheltuieli totale", "costuri", "cheltuielile"],
  ebitda: ["ebitda"],
  net_result: ["net profit", "net result", "net income", "profit", "bottom line",
               "profit net", "rezultat net", "rezultatul net", "pierdere",
               "rezultat", "profitul", "profitul net", "rezultatul",
               "pierderea"],
  current_ratio: ["current ratio", "lichiditate curenta", "rata curenta",
                  "rata lichiditatii curente", "lichiditatea curenta"],
  quick_ratio: ["quick ratio", "acid test", "lichiditate imediata",
                "rata rapida"],
  cash_ratio: ["cash ratio", "rata numerarului", "lichiditate la vedere"],
  equity_ratio: ["equity ratio", "solvency", "solvabilitate",
                 "rata capitalurilor proprii", "autonomie financiara"],
  net_margin: ["net margin", "profit margin", "marja neta", "marja de profit"],
  ebitda_margin: ["ebitda margin", "marja ebitda"],
  net_debt: ["net debt", "datorie neta", "datoria neta"],
  bank_debt_total: ["bank debt", "total debt", "borrowings", "datorii bancare",
                    "credite", "imprumuturi"],
  // Statement lines people name by their business meaning rather than by
  // the engine's row label. The label itself and every account code are
  // indexed automatically (see `buildTermIndex`); these are the phrases
  // an operator actually types.
  "bs.row.ap_trade": ["suppliers", "payables", "trade payables",
                      "accounts payable", "owe suppliers", "owe to suppliers",
                      "furnizori", "datorii catre furnizori"],
  "bs.row.ar_trade_gross": ["receivables", "trade receivables",
                            "accounts receivable", "customers owe",
                            "creante", "clienti", "creante comerciale"],
  "bs.row.share_capital": ["share capital", "capital social"],
  net_debt_ebitda: ["net debt ebitda", "net debt to ebitda", "leverage",
                    "gearing", "levier", "grad de indatorare", "indatorare",
                    "datorie neta ebitda"],
  cash_from_operating: ["operating cash flow", "cash from operations",
                        "cash flow operational", "flux de numerar operational",
                        "numerar din exploatare"],
  [FACT_PERIOD_COUNT]: ["periods", "how many periods", "period count",
                        "perioade", "cate perioade", "numar de perioade"],
  [FACT_FINDING_COUNT]: ["findings", "finding", "alerts fired", "constatari",
                         "probleme identificate"],
});

/** Presentation labels for the metric facts. Statement lines carry the
 *  engine's own label instead; these cover the computed concepts. */
const METRIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  total_assets: "Total assets",
  total_liabilities: "Total liabilities",
  equity: "Total equity",
  equity_plus_liabilities: "Equity + liabilities",
  current_assets: "Current assets",
  current_liabilities: "Current liabilities",
  non_current_assets: "Non-current assets",
  non_current_liabilities: "Non-current liabilities",
  working_capital: "Working capital",
  difference: "Balance-sheet difference",
  cash: "Cash and equivalents",
  revenue: "Net turnover",
  expenses: "Total expenses",
  ebitda: "EBITDA",
  net_result: "Net result",
  current_ratio: "Current ratio",
  quick_ratio: "Quick ratio",
  cash_ratio: "Cash ratio",
  equity_ratio: "Equity ratio",
  net_margin: "Net margin",
  ebitda_margin: "EBITDA margin",
  net_debt: "Net debt",
  bank_debt_total: "Bank debt",
  net_debt_ebitda: "Net debt / EBITDA",
  cash_from_operating: "Operating cash flow",
  [FACT_PERIOD_COUNT]: "Periods loaded",
  [FACT_FINDING_COUNT]: "Findings",
});

const RATIO_UNITS: Readonly<Record<string, FactUnit>> = Object.freeze({
  current_ratio: "ratio",
  quick_ratio: "ratio",
  cash_ratio: "ratio",
  net_debt_ebitda: "ratio",
  equity_ratio: "percent",
  net_margin: "percent",
  ebitda_margin: "percent",
});

// ══════════════════════════════════════════════════════════════════════
// Per-period construction
// ══════════════════════════════════════════════════════════════════════

type PeriodMeta = Omit<FactIndexPeriod, "factCount">;

function buildPeriodFactsInto(
  out: FactRef[],
  input: CapsuleFactPeriodInput,
): PeriodMeta {
  const statements = input.statements ?? ({} as Statements);
  const served = factsFrom(statements);
  const currency = String(statements.currency || "RON").toUpperCase();
  const periodId = input.periodId;
  const periodLabel = input.periodLabel ?? "";
  const entity = String(statements.companyName || "").trim();

  const canonical = served.canonicalForRender();
  const extraction = canonical?.extraction;
  const baseProvenance = {
    docId: input.docId,
    cell: extraction?.sheet ? `sheet ${extraction.sheet}` : undefined,
  };

  const ctx: BuildCtx = {
    out, periodId, periodLabel, currency,
    docId: input.docId, sheet: baseProvenance.cell,
    values: new Map<string, number>(),
  };

  // ── Balance sheet: gateway accessors only ────────────────────────────
  // `source: "canonical" | "legacy"` is the gateway's own presence probe;
  // this module never branches on `statements.canonical_bs` itself.
  money(ctx, "total_assets", served.totalAssets());
  money(ctx, "total_liabilities", served.totalLiabilities());
  money(ctx, "equity", served.totalEquity());
  money(ctx, "equity_plus_liabilities", served.equityPlusLiabilities());
  money(ctx, "current_assets", served.currentAssets());
  money(ctx, "current_liabilities", served.currentLiabilities());
  money(ctx, "non_current_assets", served.nonCurrentAssets());
  money(ctx, "non_current_liabilities", served.nonCurrentLiabilities());
  money(ctx, "working_capital", served.workingCapital());
  // `difference()` — the METHOD, which is the sanctioned read. A raw
  // `.difference` property read is a boundary violation by design.
  money(ctx, "difference", served.difference());

  // ── Statement lines, verbatim ────────────────────────────────────────
  const rows: readonly CanonicalBsRow[] = canonical?.rows ?? [];
  // The engine's own section subtotals, by section id. Absent sections
  // simply do not appear — `sectionTotal` is then left unset and the
  // share refuses (F1).
  const sectionTotals = new Map<string, number>();
  for (const section of canonical?.sections ?? []) {
    if (!section || typeof section.subtotal !== "number") continue;
    if (!Number.isFinite(section.subtotal) || section.subtotal === 0) continue;
    sectionTotals.set(section.id, section.subtotal);
  }
  for (const row of rows) {
    if (!row || typeof row.amount !== "number" || !Number.isFinite(row.amount)) continue;
    out.push({
      factKey: `bs.row.${row.id}`,
      label: row.label,
      labelKey: row.label_key,
      value: row.amount,
      unit: "money",
      currency,
      provenance: {
        docId: input.docId,
        cell: ctx.sheet,
        account: (row.account_codes ?? []).join(", ") || undefined,
      },
      periodId, periodLabel,
      source: "statement_line",
      accountCodes: row.account_codes,
      engineDeclared: false,
      // Carried, never derived. A row the engine did not file under a
      // section gets no section here, and `classShareOf` then refuses
      // rather than guessing one from the row id.
      section: typeof row.section === "string" && row.section ? row.section : undefined,
      sectionTotal: sectionTotals.get(row.section),
    });
  }

  // Cash: the two served cash rows are the SAME concept split by
  // currency of holding; the engine's own `cash` fact is their sum, in
  // one native currency. Adding two native-currency operands is not a
  // conversion. Absent rows contribute nothing (F1).
  const cashRows = rows.filter((r) => r && (r.id === "cash_operating" || r.id === "cash_fx"));
  // Sum and accounts come off ONE filtered array (`sumContributingRows`),
  // so the card can never name an account whose row contributed nothing.
  const cash = sumContributingRows(cashRows);
  if (cash.total !== null) {
    const total = cash.total;
    const accounts = cash.accounts;
    out.push({
      factKey: "cash",
      label: METRIC_LABELS.cash,
      labelKey: "capsule.metric.cash",
      value: total,
      unit: "money",
      currency,
      provenance: { docId: input.docId, cell: ctx.sheet, account: accounts.join(", ") || undefined },
      periodId, periodLabel,
      source: "statement_line",
      accountCodes: accounts,
      engineDeclared: true,
    });
    ctx.values.set("cash", total);
  }

  // ── P&L: the methodology block, the engine gateway's own source ──────
  const methodology = readMethodology(statements);
  // A P&L-PLACED reconciliation is not yet inside the methodology
  // figures, so the gateway adds it. Mirror the rule exactly: revenue
  // takes it only when positive (`FactsGateway.revenue`), EBITDA takes
  // it signed (`FactsGateway.ebitda`).
  const adjustment = served.reconciliationAdjustment();
  const pnlDelta =
    adjustment && adjustment.placement === "pnl" && typeof adjustment.amount === "number"
      ? adjustment.amount
      : 0;

  const revenueBase = numberAt(methodology, ["totals", "revenue_net"]);
  if (revenueBase !== null) {
    money(ctx, "revenue", revenueBase + (pnlDelta > 0 ? pnlDelta : 0), "methodology");
  }
  const ebitdaBase = numberAt(methodology, ["ebitda", "reported"]);
  if (ebitdaBase !== null) {
    money(ctx, "ebitda", ebitdaBase + pnlDelta, "methodology");
  }
  const netDebt = numberAt(methodology, ["totals", "net_debt"]);
  if (netDebt !== null) money(ctx, "net_debt", netDebt, "methodology");
  const totalDebt = numberAt(methodology, ["totals", "total_debt"]);
  if (totalDebt !== null) money(ctx, "bank_debt_total", totalDebt, "methodology");

  // Net result — sum of the served result rows, exactly as
  // `FactsGateway._result_rows_cents` does it. Absent rows refuse (F1):
  // there is no "no result row therefore zero profit" branch.
  const resultRows = rows.filter((r) => r && RESULT_ROW_IDS.indexOf(r.id) >= 0);
  const result = sumContributingRows(resultRows);
  if (result.total !== null) {
    const netResult = result.total;
    money(ctx, "net_result", netResult, "statement_line", result.accounts);
    // `expenses` is revenue − net_result, the gateway's own definition.
    const revenue = ctx.values.get("revenue");
    if (revenue !== undefined) {
      money(ctx, "expenses", revenue - netResult, "derived");
    }
  }

  // Operating cash flow — the served CF view. Present only when the
  // engine produced one.
  const cfo = numberAt(statements.assembled_cf as Record<string, unknown> | undefined,
                       ["cash_from_operating"]);
  if (cfo !== null) money(ctx, "cash_from_operating", cfo, "methodology");

  // ── Ratios: engine metrics first, native derivation second ───────────
  const metrics = input.metrics ?? null;
  ratio(ctx, metrics, "current_ratio", "ratio", "current_assets", "current_liabilities");
  ratio(ctx, metrics, "cash_ratio", "ratio", "cash", "current_liabilities");
  ratio(ctx, metrics, "equity_ratio", "share", "equity", "total_assets");
  ratio(ctx, metrics, "net_margin", "share", "net_result", "revenue");
  ratio(ctx, metrics, "ebitda_margin", "share", "ebitda", "revenue");
  ratio(ctx, metrics, "net_debt_ebitda", "ratio", "net_debt", "ebitda");
  quickRatio(ctx, metrics, rows);

  // ── Findings: the engine's numbers, the engine's units ───────────────
  for (const finding of input.findings ?? []) {
    if (!finding || !finding.factsCited) continue;
    for (const [name, value] of Object.entries(finding.factsCited)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const unit = normaliseUnit(finding.factUnits?.[name]);
      if (unit === null) continue;  // an undeclared unit is a refusal (F2)
      out.push({
        factKey: name,
        label: METRIC_LABELS[name] ?? name,
        labelKey: `capsule.metric.${name}`,
        value,
        unit,
        currency: unit === "money" ? currency : undefined,
        provenance: { docId: input.docId, cell: ctx.sheet },
        periodId, periodLabel,
        source: "finding",
        engineDeclared: ENGINE_MONEY_SET.has(name),
      });
    }
  }

  // How many findings this period carries. Built ONLY when the caller
  // supplied a findings array — an absent array means "not loaded", not
  // "none fired", and the two must not read the same (F1).
  if (Array.isArray(input.findings)) {
    out.push({
      factKey: FACT_FINDING_COUNT,
      label: "Findings",
      labelKey: "capsule.metric.finding_count",
      value: input.findings.length,
      unit: "count",
      periodId, periodLabel,
      source: "period_meta",
      engineDeclared: false,
    });
  }

  return {
    periodId,
    periodLabel,
    currency,
    entity,
    bsStatus: served.status(),
    needsReview: served.needsReview(),
    diagnosisCodes: Object.freeze(
      served.diagnosis().map((d) => d.code).filter(Boolean),
    ),
  };
}

interface BuildCtx {
  out: FactRef[];
  periodId: string;
  periodLabel: string;
  currency: string;
  docId?: string;
  sheet?: string;
  /** Resolved values by factKey, for the derivation step. */
  values: Map<string, number>;
}

function money(
  ctx: BuildCtx,
  factKey: string,
  value: number | null | undefined,
  source: FactSource = "served_bs",
  accountCodes?: readonly string[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;  // F1
  ctx.values.set(factKey, value);
  ctx.out.push({
    factKey,
    label: METRIC_LABELS[factKey] ?? factKey,
    labelKey: `capsule.metric.${factKey}`,
    value,
    unit: "money",
    currency: ctx.currency,
    provenance: {
      docId: ctx.docId,
      cell: ctx.sheet,
      account: accountCodes && accountCodes.length ? accountCodes.join(", ") : undefined,
    },
    periodId: ctx.periodId,
    periodLabel: ctx.periodLabel,
    source,
    accountCodes,
    engineDeclared: ENGINE_MONEY_SET.has(factKey),
  });
}

/** Engine metric when supplied, else NATIVE-unit division (F3). A zero
 *  or absent denominator produces nothing — a ratio against nothing is
 *  not infinity, it is unanswerable. */
function ratio(
  ctx: BuildCtx,
  metrics: Record<string, number | null> | null,
  factKey: string,
  op: "ratio" | "share",
  numeratorKey: string,
  denominatorKey: string,
): void {
  const unit = RATIO_UNITS[factKey] ?? "ratio";
  const supplied = metrics ? metrics[factKey] : undefined;
  if (typeof supplied === "number" && Number.isFinite(supplied)) {
    pushRatio(ctx, factKey, supplied, unit, "engine_metric", undefined);
    return;
  }
  const numerator = ctx.values.get(numeratorKey);
  const denominator = ctx.values.get(denominatorKey);
  if (numerator === undefined || denominator === undefined) return;  // F1
  if (denominator === 0) return;                                      // F3
  pushRatio(ctx, factKey, numerator / denominator, unit, "derived", {
    op, operands: [numeratorKey, denominatorKey],
  });
}

function quickRatio(
  ctx: BuildCtx,
  metrics: Record<string, number | null> | null,
  rows: readonly CanonicalBsRow[],
): void {
  const supplied = metrics ? metrics.quick_ratio : undefined;
  if (typeof supplied === "number" && Number.isFinite(supplied)) {
    pushRatio(ctx, "quick_ratio", supplied, "ratio", "engine_metric", undefined);
    return;
  }
  const inventoryRows = rows.filter(
    (r) => r && typeof r.id === "string" && r.id.indexOf("inventory") === 0,
  );
  if (inventoryRows.length === 0) return;  // no inventory concept served → refuse
  // A served inventory row with a null amount is an inventory concept the
  // period did not quantify. Subtracting the survivors would make the
  // quick ratio a share of a stock level nobody measured, so this refuses
  // the whole ratio rather than netting off a partial inventory.
  const inv = sumContributingRows(inventoryRows);
  if (inv.total === null || inv.skipped > 0) return;
  const inventory = inv.total;
  const currentAssets = ctx.values.get("current_assets");
  const currentLiabilities = ctx.values.get("current_liabilities");
  if (currentAssets === undefined || currentLiabilities === undefined) return;
  if (currentLiabilities === 0) return;
  pushRatio(ctx, "quick_ratio", (currentAssets - inventory) / currentLiabilities,
            "ratio", "derived", { op: "ratio", operands: ["current_assets", "current_liabilities"] });
}

function pushRatio(
  ctx: BuildCtx,
  factKey: string,
  value: number,
  unit: FactUnit,
  source: FactSource,
  derivation: FactRef["derivation"],
): void {
  if (!Number.isFinite(value)) return;
  ctx.values.set(factKey, value);
  ctx.out.push({
    factKey,
    label: METRIC_LABELS[factKey] ?? factKey,
    labelKey: `capsule.metric.${factKey}`,
    value,
    unit,
    // No currency on a dimensionless fact — the unit law.
    provenance: { docId: ctx.docId, cell: ctx.sheet },
    periodId: ctx.periodId,
    periodLabel: ctx.periodLabel,
    source,
    derivation,
    engineDeclared: false,
  });
}

// ══════════════════════════════════════════════════════════════════════
// Reading helpers
// ══════════════════════════════════════════════════════════════════════

function readMethodology(statements: Statements): Record<string, unknown> | undefined {
  const envelope = (statements as { assembled_canonical_v1?: Record<string, unknown> })
    .assembled_canonical_v1;
  if (!envelope || typeof envelope !== "object") return undefined;
  const methodology = (envelope as { methodology?: unknown }).methodology;
  return methodology && typeof methodology === "object"
    ? (methodology as Record<string, unknown>)
    : undefined;
}

/** Numeric value at a dotted path, or null. Never 0-on-missing (F1). */
function numberAt(
  source: Record<string, unknown> | undefined,
  path: readonly string[],
): number | null {
  let node: unknown = source;
  for (const key of path) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "number" && Number.isFinite(node) ? node : null;
}

/** The engine's unit strings, validated. `unknown` — the engine's own
 *  refusal token — maps to null so the fact is not built. */
function normaliseUnit(raw: string | undefined): FactUnit | null {
  switch (raw) {
    case "money":
    case "ratio":
    case "percent":
    case "days":
    case "count":
    case "score":
      return raw;
    default:
      return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Term index
// ══════════════════════════════════════════════════════════════════════

function buildTermIndex(
  byKey: ReadonlyMap<string, readonly FactRef[]>,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  const add = (term: string, factKey: string) => {
    const folded = foldQuery(term);
    if (!folded) return;
    const bucket = index.get(folded);
    if (bucket) {
      if (bucket.indexOf(factKey) < 0) bucket.push(factKey);
    } else {
      index.set(folded, [factKey]);
    }
  };

  // THE WHOLE VOCABULARY, not just the metrics this period happens to
  // carry. Indexing only the present ones looks like an optimisation and
  // is actually a silent honesty failure: a period with no P&L would
  // stop RECOGNISING the word "revenue", so "revenue" would fall through
  // to the model instead of being told, instantly, that this period does
  // not carry one. Recognition and availability are different questions.
  for (const factKey of Object.keys(METRIC_TERMS)) {
    for (const term of METRIC_TERMS[factKey]) add(term, factKey);
  }

  for (const [factKey, refs] of byKey) {
    // A statement line is named by its own label and by every account
    // code behind it — "461" and "ar intercompany" reach the same row.
    const head = refs[0];
    if (head && head.source === "statement_line") {
      add(head.label, factKey);
      for (const code of head.accountCodes ?? []) add(code, factKey);
    }
  }

  // Deterministic: a term that names two facts always lists them in the
  // same order.
  const frozen = new Map<string, readonly string[]>();
  for (const [term, keys] of index) {
    frozen.set(term, Object.freeze(keys.slice().sort()));
  }
  return frozen;
}

/** factKeys named by one raw term, best match first. Exact term beats a
 *  prefix beats containment; ties break on factKey for determinism. */
export function matchFactKeys(index: FactIndex, rawTerm: string): string[] {
  const folded = foldQuery(rawTerm);
  if (!folded) return [];
  const exact = index.termIndex.get(folded);
  if (exact && exact.length) return exact.slice();

  const scored: { key: string; score: number; term: string }[] = [];
  for (const [term, keys] of index.termIndex) {
    let score = 0;
    if (term.startsWith(folded) && folded.length >= 3) score = 2;
    else if (folded.startsWith(term) && term.length >= 3) score = 2;
    else if (term.length >= 4 && folded.indexOf(term) >= 0) score = 1;
    if (score === 0) continue;
    for (const key of keys) scored.push({ key, score, term });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.term.length - a.term.length ||
      a.key.localeCompare(b.key),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of scored) {
    if (seen.has(hit.key)) continue;
    seen.add(hit.key);
    out.push(hit.key);
  }
  return out;
}

/** One fact by key for one period, or null. The Tier-0 resolver's
 *  primitive; also the honest "we do not have that" probe. */
export function factFor(
  index: FactIndex,
  factKey: string,
  periodId?: string | null,
): FactRef | null {
  const bucket = index.byKey.get(factKey);
  if (!bucket || bucket.length === 0) return null;
  const wanted = periodId ?? index.activePeriodId;
  if (!wanted) return bucket[0];
  for (const fact of bucket) if (fact.periodId === wanted) return fact;
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// THE RESTING BRIEF — what the surface can say before a word is typed
// ══════════════════════════════════════════════════════════════════════

/**
 * A statement line's SHARE OF ITS OWN CLASS, or null.
 *
 * "461 is 21,923 RON" is a number. "461 is 21,923 RON — 0.1% of current
 * assets" is the same number with a sense of scale attached, and the
 * scale is the part a reader cannot get from the balance sheet without
 * doing the division themselves.
 *
 * THREE REFUSALS, all of them F1/F3 restated:
 *   · not a statement line, or no section  → null. There is no "share of
 *     everything" fallback; a metric that is not filed under a class has
 *     no class to be a share of.
 *   · no served section subtotal            → null. The engine's number
 *     or nothing — see `FactRef.sectionTotal`.
 *   · a non-money fact                      → null. A ratio's share of a
 *     section is not a quantity.
 *
 * The division is NATIVE-UNIT (F3): both operands are the same period in
 * the same source currency, so the result is dimensionless and does not
 * move when the display-currency dial does. It is returned as a FRACTION,
 * not a formatted percent — the surface owns the rendering, and a figure
 * formatted here would bypass the money path.
 */
export function classShareOf(
  fact: FactRef | null | undefined,
): { share: number; section: string } | null {
  if (!fact || fact.source !== "statement_line") return null;
  if (fact.unit !== "money") return null;
  const section = fact.section;
  const total = fact.sectionTotal;
  if (!section) return null;
  // ABSENT IS NOT ZERO, and it is not "close enough" either. An absent
  // or zero section subtotal has no share to compute, so this REFUSES.
  //
  // A stopped wave left a plant here that fell back to `fact.value * 100`
  // — a fabricated denominator, which renders a plausible percentage for
  // a figure whose real share is unknown. That is the failure mode this
  // codebase exists to prevent, dressed as a convenience.
  if (typeof total !== "number" || !Number.isFinite(total) || total === 0) {
    return null;
  }
  const share = fact.value / total;
  if (!Number.isFinite(share)) return null;
  return { share, section };
}

/**
 * THE ORDER THE RESTING TILES ARE PICKED IN.
 *
 * Money before ratios, and inside money the four figures an operator
 * opens this product to read. It is a DECLARED preference list rather
 * than a scoring function because the resting surface has to be the same
 * every time it opens: a tile that reorders itself between two openings
 * of the same workspace is a tile the reader has to re-read.
 *
 * The list is longer than the three slots on purpose — it is a fallback
 * CHAIN, so a period that carries no revenue shows the next thing it
 * does carry instead of showing two tiles and a hole.
 */
export const RESTING_FACT_ORDER: readonly string[] = Object.freeze([
  "revenue", "ebitda", "cash", "net_debt", "net_result",
  "total_assets", "equity", "working_capital",
  "current_ratio", "equity_ratio", "net_debt_ebitda", "net_margin",
]);

/** The fact that outranks the whole list when the books do not balance.
 *  A workspace whose balance sheet is out is not one where revenue is
 *  the most consequential number on screen. */
const IMBALANCE_FACT = "difference";

/**
 * Up to `limit` headline facts for the ACTIVE period, ranked.
 *
 * Everything here is derived from what the index actually carries:
 *
 *   · a fact the period does not have contributes nothing — the tile row
 *     is short, never padded (F1). Zero tiles is a legal answer;
 *   · `difference` is promoted to the FRONT when it is present and
 *     non-zero, because an unbalanced period's most consequential figure
 *     is the gap. A zero difference is not promoted and is never shown
 *     as a tile: "the books balance" is the trust chip's sentence, and
 *     printing a 0 beside three real figures reads as a fourth
 *     measurement rather than as an absence of one;
 *   · order is otherwise `RESTING_FACT_ORDER`, so the same workspace
 *     opens the same way twice (F4).
 *
 * No clock, no storage, no fetch — the same index always yields the same
 * tiles in the same order.
 */
export function restingFacts(index: FactIndex, limit = 3): FactRef[] {
  if (!index || limit <= 0) return [];
  const out: FactRef[] = [];
  const seen = new Set<string>();

  const take = (key: string): void => {
    if (out.length >= limit || seen.has(key)) return;
    const fact = factFor(index, key);
    if (!fact) return;
    if (!Number.isFinite(fact.value)) return;
    seen.add(key);
    out.push(fact);
  };

  const drift = factFor(index, IMBALANCE_FACT);
  if (drift && Number.isFinite(drift.value) && drift.value !== 0) take(IMBALANCE_FACT);

  for (const key of RESTING_FACT_ORDER) take(key);
  return out;
}

/** The standing period context a Tier-1 prompt is cached against: the
 *  headline facts of the active period, resolved and provenance-bearing.
 *  Returned as FACTS, never as prose — the answer lane formats them, so
 *  no figure ever originates in a prompt string. */
export function standingContextFacts(index: FactIndex): FactRef[] {
  const keys = [
    "total_assets", "total_liabilities", "equity", "current_assets",
    "current_liabilities", "cash", "revenue", "ebitda", "net_result",
    "difference",
  ];
  const out: FactRef[] = [];
  for (const key of keys) {
    const fact = factFor(index, key);
    if (fact) out.push(fact);
  }
  return out;
}

/** `Amount`'s `kind` for a fact unit, so no surface invents the mapping.
 *  `days` and `score` are counts of things, not money and not ratios. */
export function amountKindFor(unit: string): "money" | "percent" | "multiple" | "count" {
  switch (unit) {
    case "money": return "money";
    case "percent": return "percent";
    case "ratio": return "multiple";
    default: return "count";
  }
}

/** `AmountProvenance` for a fact — the affordance payload, built from
 *  what the fact actually carries. Returns null when there is nothing
 *  behind it, so the surface never renders a trust affordance over an
 *  empty card.
 *
 *  ONE FIELD PER KIND OF CLAIM. Account codes used to be folded into
 *  `source` as "accounts 461", and the period was not carried at all —
 *  which is how a sibling surface came to put the PERIOD LABEL in the
 *  source slot and render "Source  FY 2025" over a figure whose real
 *  origin (sheet + accounts) it was discarding. A period is not a
 *  source and an account is not a sheet; the card labels them
 *  separately because they are separately checkable.
 *
 *  `period` alone never buys the affordance — every fact in the index
 *  carries one (see `hasProvenance`). It rides along to say WHICH
 *  period the cited cells belong to. */
export function amountProvenanceFor(fact: FactRef): {
  source?: string;
  accounts?: string;
  period?: string;
  method?: string;
} | null {
  const bits: string[] = [];
  if (fact.provenance?.cell) bits.push(fact.provenance.cell);
  if (fact.provenance?.docId) bits.push(`doc ${fact.provenance.docId}`);
  const source = bits.join(" · ");
  const accounts =
    fact.provenance?.account || (fact.accountCodes ?? []).join(", ") || "";
  const method = fact.derivation
    ? `${fact.derivation.op} of ${fact.derivation.operands.join(" / ")}`
    : fact.source;
  if (!source && !accounts && !method) return null;
  return {
    source: source || undefined,
    accounts: accounts || undefined,
    period: fact.periodLabel || undefined,
    method,
  };
}
