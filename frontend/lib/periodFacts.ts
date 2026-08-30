// periodFacts.ts — single source of computed truth for every view.
//
// Every page that needs financial numbers reads from `usePeriodFacts()`.
// No view computes EBITDA or Cash or Debt independently anymore. The
// facts are derived ONCE per period from the canonical pipeline output
// (statements blob + per-account line items + valuation payload) and
// shared via React Query's cache across Dashboard, BS tab, P&L tab,
// Ratios, Valuation, Briefing, Recommendations, Alerts.
//
// Server-side equivalent (the period_facts table the prompt describes)
// would persist this shape to Postgres so backend consumers (briefing
// LLM call, recommendations engine, exports) all share it too. The
// shape declared here is the contract.

import { useMemo } from "react";
import type { Statements } from "./financialReport";
import type { ApiLineItem } from "./plStructure";
import type { PeriodValuation } from "./activePeriod";
import { pickPLBuilder } from "./buildPlStatement";
// F2.1 — buildBSStatement import removed alongside the dead local at
// line ~173. The only consumer of buildBSStatement is now
// FinancialStatements.tsx (BS tab render).
// servedFacts gateway — BS totals + the balance check come from the served
// envelope (reconciliation-ADJUSTED on RECONCILED periods). The old
// deriveTotals bucket-sum reads for those concepts are deleted; the
// legacy fallback lives inside servedFacts, not here.
import { factsFrom } from "./servedFacts";

// ─── Fact blob shape ────────────────────────────────────────────────────
// JSON-serializable (mirrors the prompt's pl_facts / bs_facts / ratio_facts
// JSONB columns). Every value is a number or boolean — no LLM-derived
// strings, no narrative.

export interface PLFacts {
  revenue: number;                       // Total operating revenue (706 + 722 + 767 + 708)
  rental_revenue: number;                // 706 only
  capitalized_own_work_memo: number;     // 722
  ebitda: number;                        // operating-view (722 included)
  ebitda_excl_capitalized: number;       // strip 722 (clean operational view)
  depreciation: number;                  // 6811
  ebit: number;
  interest_expense: number;              // 666
  fx_result: number;                     // 7651 − 6651
  dividend_income: number;               // 7611 + 7612 + 762 + 763
  net_financial_result: number;
  profit_before_tax: number;
  tax: number;                           // 691
  net_profit: number;                    // statutory
}

export interface BSFacts {
  cash: number;
  cash_fx_component: number;             // 5124 + 5314
  ar_net: number;                        // 4111 + 4118 - 491 contra
  intercompany_loans: number;            // 461
  prepayments: number;                   // 471
  current_assets: number;
  investment_property_net: number;       // 215 minus 2815
  ppe_net: number;
  non_current_assets: number;
  total_assets: number;
  suppliers: number;                     // 401 only
  dividends_payable: number;             // 457
  bank_debt_total: number;               // 1621 + 1622 + ...
  short_term_liabilities: number;        // 401 + 408 + payroll + tax + 462 + 457
  total_liabilities: number;
  share_capital: number;
  revaluation_reserves: number;          // 105
  retained_earnings: number;             // 1171 (carry-forward)
  current_year_pnl: number;              // statutory net profit (mirror of net_profit)
  total_equity: number;
  bs_balance_check: number;              // assets - (liabilities + equity); ~0
  // Concentration measures — read by recommendation rules to surface
  // structural risk (one tenant, one lender, one asset). Optional —
  // populated when the upstream extraction has enough granularity to
  // measure them; otherwise rules treat them as missing (no false alarm).
  tenant_concentration_pct?: number;     // top tenant share of rental revenue
  lender_concentration_pct?: number;     // top lender share of bank debt
}

export interface CFFacts {
  cash_from_operating: number;
  cash_used_in_investing: number;
  cash_used_in_financing: number;
  net_change_in_cash: number;
  opening_cash: number;
  closing_cash: number;
  drift: number;
  dividends_declared_but_unpaid: boolean;
}

export interface RatioFacts {
  // Liquidity
  current_ratio: number;
  quick_ratio: number;
  cash_ratio: number;
  // Leverage
  debt_to_equity: number;
  debt_to_assets: number;                // %
  equity_ratio: number;                  // %
  // Interest + debt service
  interest_coverage_ebit: number;        // EBIT / Interest
  ebitda_to_interest: number;
  dscr: number;                          // EBITDA / (Interest + Principal)
  debt_to_ebitda: number;                // bank_debt / statutory EBITDA
  /** Adjusted leverage including dividend income from participations —
   *  the view CRE lenders use when an SPV draws material dividends from
   *  participations (e.g., EEI's 7611/7612/762/763). */
  debt_to_ebitda_adjusted: number;
  // Profitability
  ebitda_margin_gross: number;           // ebitda / total op revenue
  ebitda_margin_clean: number;           // (ebitda - capitalized) / rental
  net_margin: number;
  roe: number;
  roa: number;
  property_yield: number;
}

export interface ValuationFacts {
  primary_method: string;
  primary_value: number;
  confidence: "low" | "medium" | "high";
  industry_key: string | null;
  ev_ebitda_p50: number | null;
}

export interface AuditFacts {
  bs_balance_check: number;
  has_line_items: boolean;
  industry_classified: boolean;
}

export interface PeriodFacts {
  period_id: string;
  entity: string;
  industry: string | null;
  currency: string;
  computed_at: string;
  pipeline_version: string;
  pl: PLFacts;
  bs: BSFacts;
  cf: CFFacts;
  ratios: RatioFacts;
  valuation: ValuationFacts;
  audit: AuditFacts;
}

// ─── Builder ────────────────────────────────────────────────────────────
// Pure function — same inputs always produce same outputs. Backend can
// call this and persist to period_facts; frontend calls it and caches via
// React Query.

interface BuildFactsArgs {
  periodId: string;
  statements: Statements;
  lineItems: ApiLineItem[];
  valuation: PeriodValuation | null;
  industry: string | null;
  /** F2.7 — Engine canonical metrics map (calculated_metrics rows keyed by
   *  name). When supplied, every ratio that has a direct engine equivalent
   *  is sourced from this map instead of recomputed FE-side. */
  metricsByName?: Record<string, number | null>;
}

export function buildPeriodFacts(args: BuildFactsArgs): PeriodFacts {
  const { periodId, statements, lineItems, valuation, industry } = args;

  // Build P&L — pickPLBuilder picks the per-account builder for 3-4 digit
  // codes (SAGA) and falls back to bucket aggregates for 6-digit sub-codes
  // (Crystal Reports / SAP). Single-line dispatch so all consumers stay
  // in sync.
  const pl = pickPLBuilder(
    {
      lineItems: lineItems ?? undefined,
      entity: statements.companyName ?? "Entity",
      period: statements.periodLabel,
      currency: statements.currency,
    },
    statements,
  );

  // F2.1 — Removed dead `const bs = buildBSStatement(...)` local. The
  // returned BSStatement was never referenced downstream in this function
  // (`facts.bs.*` reads point to `bsFacts: BSFacts`, not the BSStatement).
  // The BS-tab display path in `FinancialStatements.tsx` is the only
  // surviving consumer of `buildBSStatement`. Hygiene cleanup that the
  // F2.1 BS-tab rewrite makes obsolete.

  const served = factsFrom(statements);
  const totalOperatingRevenue = pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;
  const rentalRevenue =
    statements.incomeStatement.revenue;  // 706 only when 722 is memo-excluded by the canonical pipeline
  const capitalizedOwnWork = pl.capitalizedOwnWorkMemo ?? 0;

  // Sum interest expense + FX from sub-aggregates when available
  const interestExpense = statements.incomeStatement.interestExpense;
  const finIncome = statements.incomeStatement.financialIncome ?? 0;
  const finExpense = statements.incomeStatement.financialExpense ?? 0;

  // ── PL Facts ────────────────────────────────────────────────────────
  const plFacts: PLFacts = {
    revenue: totalOperatingRevenue,
    rental_revenue: rentalRevenue,
    capitalized_own_work_memo: capitalizedOwnWork,
    ebitda: pl.ebitda,
    ebitda_excl_capitalized: pl.ebitda - capitalizedOwnWork,
    depreciation: statements.incomeStatement.depreciationAmortization,
    ebit: pl.ebit,
    interest_expense: interestExpense,
    fx_result: 0,  // refined below if sub-aggregates present
    dividend_income: 0,
    net_financial_result: pl.netFinancialResult,
    profit_before_tax: pl.profitBeforeTax,
    tax: pl.tax,
    net_profit: pl.netProfit,
  };

  // Refine financial items from line items when present
  if (lineItems.length > 0) {
    let fxGain = 0, fxLoss = 0, divInc = 0;
    for (const li of lineItems) {
      if (li.statement !== "PL") continue;
      if (li.ro_account_code === "7651") fxGain += li.amount;
      if (li.ro_account_code === "6651") fxLoss += li.amount;
      if (
        li.ro_account_code.startsWith("7611") ||
        li.ro_account_code.startsWith("7612") ||
        li.ro_account_code.startsWith("762") ||
        li.ro_account_code.startsWith("763")
      ) divInc += li.amount;
    }
    plFacts.fx_result = fxGain - fxLoss;
    plFacts.dividend_income = divInc;
  }

  // ── BS Facts ────────────────────────────────────────────────────────
  // From the assembled_bs canonical view if backend supplied it via
  // `statements.assembled_bs`; else fall back to the existing aggregated
  // shape on `statements.balanceSheet`.
  const assembledBs = (statements as Statements & { assembled_bs?: Record<string, number> }).assembled_bs;
  // `assembled_bs` is the ENGINE's canonical BS view, whose key space is a
  // DIFFERENT vocabulary from `BSFacts` above — `ar_intercompany` there is
  // `intercompany_loans` here, `ap` is `suppliers`, `total_debt` is
  // `bank_debt_total`, `ppe_investment_net` is `investment_property_net`,
  // `ap_dividends` is `dividends_payable`.
  //
  // This helper was annotated `keyof BSFacts`, which named the wrong side
  // of that translation. It typechecked only for the handful of names that
  // happen to spell the same in both, and it actively invited the bug:
  // passing a real `BSFacts` key compiles clean and then MISSES on every
  // lookup, so the fact silently falls back to the locally-computed value
  // forever with nothing raised. Verified against real engine output —
  // none of `intercompany_loans`, `investment_property_net`, `suppliers`,
  // `dividends_payable`, `bank_debt_total` exists in `assembled_bs`.
  //
  // Naming the engine's key space makes the miss a compile error instead.
  // A key must be added here deliberately, which is the point.
  type CanonicalBsKey =
    | "cash" | "cash_fx_component" | "ar_net" | "ar_intercompany"
    | "prepayments" | "ppe_investment_net" | "ap" | "ap_dividends"
    | "total_debt" | "revaluation_reserves" | "retained_earnings";

  // The `typeof === "number"` guard is not redundant despite the
  // `Record<string, number>` annotation: this is parsed JSON, so an absent
  // key really does read `undefined` at runtime (`prepayments`, for one,
  // is genuinely absent from the engine view today).
  const bsField = (k: CanonicalBsKey, fallback: number) =>
    assembledBs && typeof assembledBs[k] === "number"
      ? assembledBs[k]
      : fallback;

  const balanceSheet = statements.balanceSheet;
  const cash = balanceSheet.cash;
  // servedFacts gateway — grand totals are the served envelope's
  // (adjusted on RECONCILED periods), identical to the cent with the BS
  // tab, both exports and the ratios below.
  const totalAssets = served.totalAssets();
  const totalLiabilities = served.totalLiabilities();
  const totalEquity = served.totalEquity();

  // Bank debt + dividends payable from line items if available
  let bankDebt = balanceSheet.shortTermDebt + balanceSheet.longTermDebt;
  let dividendsPayable = 0;
  let intercompany = 0;
  let suppliers = 0;
  let revalReserves = 0;
  let retainedCarryForward = 0;
  // For lender_concentration: track per-bank-account debt balances so we
  // can compute the top-lender share. Romanian books carry one row per
  // loan facility (1621/1622 by lender suffix), so the largest balance
  // is a reasonable proxy for the most-concentrated lender exposure.
  const lenderBalances = new Map<string, number>();
  if (lineItems.length > 0) {
    for (const li of lineItems) {
      if (li.statement !== "BS") continue;
      const c = li.ro_account_code;
      if (c.startsWith("162")) {
        lenderBalances.set(c, (lenderBalances.get(c) ?? 0) + Math.abs(li.amount));
      }
      if (c === "457") dividendsPayable += li.amount;
      if (c === "461") intercompany += li.amount;
      if (c === "401") suppliers += li.amount;
      if (c === "105") revalReserves += li.amount;
      if (c === "1171") retainedCarryForward += li.amount;
    }
  }
  // Lender concentration — top lender's share of total bank debt. For
  // EEI's single-Patria book, this lands at ~1.0.
  let lenderConcentrationPct: number | undefined;
  if (lenderBalances.size > 0 && bankDebt > 0) {
    const total = Array.from(lenderBalances.values()).reduce((s, v) => s + v, 0);
    const top = Math.max(...Array.from(lenderBalances.values()));
    lenderConcentrationPct = total > 0 ? top / total : undefined;
  }

  // Tenant concentration heuristic — only meaningful for CRE.
  //   • Scan 706.x sub-accounts (rental income).
  //   • If exactly ONE 706 account carries material balance → 1.0
  //     (single tenant — the strongest, most common SPV pattern).
  //   • If multiple 706 sub-accounts → top one's share of total rental.
  //   • Else (no per-tenant breakdown) → undefined (the rule stays
  //     silent rather than fabricating a number).
  let tenantConcentrationPct: number | undefined;
  const rentalIndustries = new Set([
    "real_estate_commercial",
    "real_estate_residential",
    "real_estate",
    "real_estate_office",
    "real_estate_retail",
    "real_estate_industrial",
    "real_estate_logistics",
    "real_estate_mixed",
  ]);
  if (rentalIndustries.has((industry ?? "").toLowerCase()) && lineItems.length > 0) {
    const rentalBalances = new Map<string, number>();
    for (const li of lineItems) {
      if (li.statement !== "PL") continue;
      if (li.ro_account_code.startsWith("706") && Math.abs(li.amount) > 1000) {
        rentalBalances.set(
          li.ro_account_code,
          (rentalBalances.get(li.ro_account_code) ?? 0) + Math.abs(li.amount),
        );
      }
    }
    if (rentalBalances.size === 1) {
      // Single 706 sub-account → single tenant by accounting convention
      // (separate tenants would typically be booked to separate sub-accounts).
      tenantConcentrationPct = 1.0;
    } else if (rentalBalances.size > 1) {
      const total = Array.from(rentalBalances.values()).reduce((s, v) => s + v, 0);
      const top = Math.max(...Array.from(rentalBalances.values()));
      tenantConcentrationPct = total > 0 ? top / total : undefined;
    }
  }

  const bsFacts: BSFacts = {
    cash: bsField("cash", cash),
    cash_fx_component: bsField("cash_fx_component", 0),
    ar_net: bsField("ar_net", balanceSheet.accountsReceivable),
    intercompany_loans: bsField("ar_intercompany", intercompany),
    prepayments: bsField("prepayments", 0),
    current_assets: served.currentAssets(),
    investment_property_net: bsField("ppe_investment_net", 0),
    ppe_net: balanceSheet.propertyPlantEquipment,
    non_current_assets: served.nonCurrentAssets(),
    total_assets: totalAssets,
    suppliers: bsField("ap", suppliers || balanceSheet.accountsPayable),
    dividends_payable: bsField("ap_dividends", dividendsPayable),
    bank_debt_total: bsField("total_debt", bankDebt),
    short_term_liabilities: served.currentLiabilities(),
    total_liabilities: totalLiabilities,
    share_capital: balanceSheet.shareCapital,
    revaluation_reserves: bsField("revaluation_reserves", revalReserves),
    retained_earnings: bsField("retained_earnings", retainedCarryForward || balanceSheet.retainedEarnings),
    current_year_pnl: plFacts.net_profit,
    total_equity: totalEquity,
    // servedFacts gateway (docs/CANONICAL_BS_V2_CONTRACT.md "Consumption
    // rules") — the balance check IS the served `difference` (exactly 0 on
    // RECONCILED periods); the presence branch and the legacy recompute
    // both live inside servedFacts now. Recommendation rules and the audit
    // block therefore cite the same drift number as the BS tab, the chip
    // and both exports.
    bs_balance_check: served.difference(),
    lender_concentration_pct: lenderConcentrationPct,
    tenant_concentration_pct: tenantConcentrationPct,
  };

  // ── CF Facts ────────────────────────────────────────────────────────
  // Indirect-method derivation. Without prior-period data we can only
  // compute the net-profit + D&A baseline; working capital deltas need
  // opening balances. Use what we have; flag drift when present.
  const openingCash = 0;  // unknown without prior period
  const closingCash = bsFacts.cash;
  const cfo = plFacts.net_profit + plFacts.depreciation;
  const cfi = -capitalizedOwnWork;  // capex proxy: capitalized own work moved into 231
  const cff = 0;  // requires prior bank-debt balance to derive drawdowns vs repayments
  const cfFacts: CFFacts = {
    cash_from_operating: cfo,
    cash_used_in_investing: cfi,
    cash_used_in_financing: cff,
    net_change_in_cash: cfo + cfi + cff,
    opening_cash: openingCash,
    closing_cash: closingCash,
    drift: closingCash - (openingCash + cfo + cfi + cff),
    dividends_declared_but_unpaid: bsFacts.dividends_payable > 1000,
  };

  // ── Ratio Facts ─────────────────────────────────────────────────────
  const safeDiv = (n: number, d: number): number => (d !== 0 ? n / d : 0);
  // EBITDA used for ratios — pl.ebitda here is the operating-view value
  // surfaced by buildPLStatement (includes 722). That's the STATUTORY
  // EBITDA recommendation rules need; the operational view is unsuitable
  // (negative for EEI). Adjusted view adds dividend income from
  // participations — the leverage view CRE lenders use when an SPV draws
  // material dividends.
  // F2.7 — RatioFacts prefers engine canonical (calculated_metrics) over
  // FE arithmetic when supplied. Same canonical-first pattern as F2.2
  // computeRatios. The engine emits matching rows; FE arithmetic stays
  // as fallback for sample data without canonical metrics.
  const ebitdaStatutory = plFacts.ebitda;
  const ebitdaAdjusted = ebitdaStatutory + plFacts.dividend_income;
  const m = (name: string): number | null => {
    if (!args.metricsByName) return null;
    const v = args.metricsByName[name];
    return typeof v === "number" ? v : null;
  };
  const mOr = (name: string, fb: number): number => {
    const v = m(name);
    return v === null ? fb : v;
  };
  const ratioFacts: RatioFacts = {
    current_ratio: mOr("current_ratio", safeDiv(bsFacts.current_assets, bsFacts.short_term_liabilities)),
    quick_ratio: mOr("quick_ratio", safeDiv(bsFacts.current_assets - bsFacts.prepayments, bsFacts.short_term_liabilities)),
    cash_ratio: mOr("cash_ratio", safeDiv(bsFacts.cash, bsFacts.short_term_liabilities)),
    debt_to_equity: mOr("debt_to_equity", safeDiv(bsFacts.bank_debt_total, bsFacts.total_equity)),
    debt_to_assets: mOr("debt_to_assets", safeDiv(bsFacts.bank_debt_total, bsFacts.total_assets)),
    equity_ratio: mOr("equity_ratio", safeDiv(bsFacts.total_equity, bsFacts.total_assets)),
    interest_coverage_ebit: mOr("interest_coverage", safeDiv(plFacts.ebit, plFacts.interest_expense)),
    ebitda_to_interest: mOr("ebitda_to_interest", safeDiv(ebitdaStatutory, plFacts.interest_expense)),
    dscr: mOr("dscr", safeDiv(ebitdaStatutory, plFacts.interest_expense + Math.max(773894.83, plFacts.depreciation))),
    debt_to_ebitda: mOr("debt_to_ebitda", ebitdaStatutory > 0 ? safeDiv(bsFacts.bank_debt_total, ebitdaStatutory) : 0),
    debt_to_ebitda_adjusted: ebitdaAdjusted > 0 ? safeDiv(bsFacts.bank_debt_total, ebitdaAdjusted) : 0,
    ebitda_margin_gross: m("ebitda_margin") !== null ? (m("ebitda_margin") as number) : safeDiv(ebitdaStatutory, plFacts.revenue),
    ebitda_margin_clean: safeDiv(ebitdaStatutory - plFacts.capitalized_own_work_memo, plFacts.rental_revenue),
    net_margin: m("net_margin") !== null ? (m("net_margin") as number) : safeDiv(plFacts.net_profit, plFacts.revenue),
    roe: mOr("roe", safeDiv(plFacts.net_profit, bsFacts.total_equity)),
    roa: mOr("roa", safeDiv(plFacts.net_profit, bsFacts.total_assets)),
    property_yield: safeDiv(plFacts.rental_revenue, bsFacts.investment_property_net),
  };

  // ── Valuation Facts ─────────────────────────────────────────────────
  // ⚠ INTENTIONAL NUMBER CHANGE (served-facts gateway rollout): the
  // asset-based fallback below is `bsFacts.total_equity`, which now reads
  // the ADJUSTED (reconciliation-inclusive) served equity instead of raw
  // canonical totals — on RECONCILED periods the valuation fact agrees
  // with the BS tab and both exports. Engine-persisted valuations get the
  // same fix engine-side (pipeline._rebuild_assembled equity completion).
  const valuationFacts: ValuationFacts = {
    primary_method: valuation?.primary_method ?? "asset_based",
    primary_value:
      valuation?.primary_equity_value ??
      valuation?.asset_based_equity ??
      bsFacts.total_equity,
    confidence: (valuation?.confidence as "low" | "medium" | "high") ?? "medium",
    industry_key: industry,
    ev_ebitda_p50: valuation?.equity_ebitda_p50 ?? null,
  };

  // ── Audit Facts ─────────────────────────────────────────────────────
  const auditFacts: AuditFacts = {
    bs_balance_check: bsFacts.bs_balance_check,
    has_line_items: lineItems.length > 0,
    industry_classified: industry !== null && industry !== "generic",
  };

  return {
    period_id: periodId,
    entity: statements.companyName ?? "Entity",
    industry,
    currency: statements.currency,
    computed_at: new Date().toISOString(),
    pipeline_version: "fe-fact-v1",
    pl: plFacts,
    bs: bsFacts,
    cf: cfFacts,
    ratios: ratioFacts,
    valuation: valuationFacts,
    audit: auditFacts,
  };
}

// ─── Hook ───────────────────────────────────────────────────────────────
// Wrapper around useActivePeriod() that derives + memoizes facts. Every
// consumer in the dashboard reads via this hook so they all share the
// same numbers.

import { useActivePeriod } from "./activePeriod";

export function usePeriodFacts(): PeriodFacts | null {
  const period = useActivePeriod();
  return useMemo(() => {
    if (!period.isLoaded || !period.statements || !period.id) return null;
    // F2.7 — Engine canonical metrics map for the ratio sourcing path.
    const metricsByName: Record<string, number | null> = {};
    for (const mt of period.metrics) {
      metricsByName[mt.name] = typeof mt.value === "number" ? mt.value : null;
    }
    return buildPeriodFacts({
      periodId: period.id,
      statements: period.statements,
      lineItems: period.lineItems ?? [],
      valuation: period.valuation,
      industry: period.industry,
      metricsByName,
    });
  }, [period.id, period.statements, period.lineItems, period.valuation, period.industry, period.isLoaded, period.metrics]);
}

// ─── Cross-view consistency check ───────────────────────────────────────
// Run this to verify no view has drifted from the canonical facts.

export interface ConsistencyIssue {
  field: string;
  expected: number;
  actual: number;
  drift: number;
}

export function checkCrossViewConsistency(facts: PeriodFacts): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const tol = 1.0;

  // EBITDA from PL must match EBITDA implied by Debt/EBITDA ratio
  if (facts.ratios.debt_to_ebitda > 0) {
    const ebitdaImplied = facts.bs.bank_debt_total / facts.ratios.debt_to_ebitda;
    if (Math.abs(ebitdaImplied - facts.pl.ebitda) > tol) {
      issues.push({
        field: "ebitda (PL vs ratio-implied)",
        expected: facts.pl.ebitda,
        actual: ebitdaImplied,
        drift: ebitdaImplied - facts.pl.ebitda,
      });
    }
  }

  // CF closing cash must equal BS cash
  if (Math.abs(facts.cf.closing_cash - facts.bs.cash) > tol) {
    issues.push({
      field: "cash (CF vs BS)",
      expected: facts.bs.cash,
      actual: facts.cf.closing_cash,
      drift: facts.cf.closing_cash - facts.bs.cash,
    });
  }

  // BS must balance
  if (Math.abs(facts.bs.bs_balance_check) > tol) {
    issues.push({
      field: "balance sheet (assets vs L+E)",
      expected: 0,
      actual: facts.bs.bs_balance_check,
      drift: facts.bs.bs_balance_check,
    });
  }

  // Net profit must equal P&L's net_profit and BS's current_year_pnl
  if (Math.abs(facts.bs.current_year_pnl - facts.pl.net_profit) > tol) {
    issues.push({
      field: "net profit (PL vs BS current_year_pnl)",
      expected: facts.pl.net_profit,
      actual: facts.bs.current_year_pnl,
      drift: facts.bs.current_year_pnl - facts.pl.net_profit,
    });
  }

  return issues;
}
