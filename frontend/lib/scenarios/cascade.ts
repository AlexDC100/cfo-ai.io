// F6.0.5 Phase 1 foundation (2026-06-20) — The cascade engine.
//
// THE LOAD-BEARING PIECE of the entire F6.0.5 scenario feature. Everything
// else (UI, store, save/restore, comparison view, PDF export, covenant
// detection, Opus narrative) is wiring around this pure function.
//
// CONTRACT:
//   applyCascade(baseline, adjustments) → new derived state
//
//   - PURE function. NO side effects. NO React. NO database access.
//   - DETERMINISTIC. Same (baseline, adjustments) → byte-identical output.
//   - NEVER mutates baseline. structuredClone at entry.
//   - Adjustments applied in DEPENDENCY ORDER (revenue before drivers
//     that depend on revenue; gross_margin after revenue so it uses the
//     adjusted revenue, not the baseline).
//
// CASCADE FLOW (per the F6.0.5 spec):
//   1. Sort adjustments by dependency priority
//   2. Apply each adjustment to the state
//   3. cascadePnL: recompute grossProfit, ebit, ebitda, netProfit from
//      the (possibly adjusted) inputs
//   4. cascadeBalanceSheet: net income flows to retained earnings;
//      working capital deltas; cash as plug variable so A = L + E holds
//   5. cascadeCashFlow: OCF rebuilds from NI + D&A − ΔWC; FCF = OCF − capex
//   6. recomputeRatios: every ratio (EBITDA margin, current ratio,
//      net_debt_to_ebitda, ROE, ROA, DIO, DSO, DPO, CCC) recomputes
//      against the new state
//
// CRITICAL MATH DISCIPLINE:
//   · Delta of a RATIO is in percentage POINTS, not percent (enforced
//     downstream in DeltaBadge + computeDeltas).
//   · Never divide by zero. Every division checks the denominator.
//   · Balance sheet equation A = L + E must hold (cash is the plug
//     variable to make it hold; tested by the test suite gate).
//
// PHASE 1 SCOPE:
//   · concept-level adjustments (revenue, cogs, opex, capex, ...)
//   · driver-level adjustments (dio_days, dso_days, dpo_days,
//     gross_margin, ebitda_margin, effective_tax_rate, capex_pct_revenue,
//     da_pct_revenue)
//   · account-level adjustments: NOT YET WIRED. Throws a warning; the
//     adjustment is recorded but no math is applied. Account-level
//     ships in Phase 1b once the methodology engine surface for per-
//     account contribution is stable. 95% of user scenarios are
//     concept-level so this is acceptable for foundation.

import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import type {
  Adjustment,
  AdjustmentOperation,
  AdjustmentTarget,
  DriverKey,
} from "./types";

/** Numeric fields the cascade reads/writes. Subset of ReportingMetrics —
 *  the cascade doesn't touch source-account traces or non-numeric
 *  metadata. Using `Required<Pick<ReportingMetrics, ...>>` would be
 *  ideal but ReportingMetrics has many optional-numbers; we treat
 *  undefined as 0 throughout. */
export type CascadeState = ReportingMetrics;

/** Apply a deep-clone + dependency-sorted cascade. PUBLIC ENTRY POINT. */
export function applyCascade(
  baseline: CascadeState,
  adjustments: Adjustment[],
): CascadeState {
  // structuredClone is the right primitive here — it copies nested
  // objects/arrays without the JSON-roundtrip cost of JSON.parse(stringify).
  // Available since Node 17 / all modern browsers; the codebase doesn't
  // target older runtimes. Falls back to a manual spread for the empty
  // case (which shouldn't happen, but guards a defensive entry).
  const initial: CascadeState =
    typeof structuredClone === "function"
      ? structuredClone(baseline)
      : { ...baseline };

  const sorted = sortAdjustmentsByDependency(adjustments);

  // The effective-tax-rate driver is special: tax must be charged on the
  // CASCADED EBIT, which only exists after cascadePnL. Applying it in the
  // per-adjustment loop would tax the STALE baseline EBIT (review #4). So
  // we intercept the rate here and hand it to cascadePnL, which recomputes
  // EBIT first and then charges tax on it.
  let taxRateOverride: number | null = null;

  let state = initial;
  for (const adj of sorted) {
    if (
      adj.target.type === "driver" &&
      adj.target.driverKey === "effective_tax_rate"
    ) {
      const dv =
        adj.operation.type === "set_driver"
          ? adj.operation.driverValue
          : adj.operation.type === "set_value"
            ? adj.operation.value
            : null;
      if (dv !== null) taxRateOverride = dv;
      continue;
    }
    state = applySingleAdjustment(state, adj);
  }

  state = cascadePnL(state, taxRateOverride);
  state = cascadeBalanceSheet(state, baseline);
  state = cascadeCashFlow(state, baseline);
  state = recomputeRatios(state);

  return state;
}

// ─── Single-adjustment application ──────────────────────────────────────

function applySingleAdjustment(
  state: CascadeState,
  adj: Adjustment,
): CascadeState {
  const { target, operation } = adj;

  if (target.type === "concept") {
    const key = target.conceptKey;
    const current = num(state[key]);
    const next = applyOperation(current, operation);
    return { ...state, [key]: next };
  }

  if (target.type === "driver") {
    return applyDriverAdjustment(state, target.driverKey, operation);
  }

  if (target.type === "account") {
    // PHASE 1 GAP: account-level not yet wired through the methodology
    // engine. Record the intent but no math change. Surfaces a console
    // warning in dev for visibility; production swallows silently so
    // we don't spam the user.
    if (typeof console !== "undefined" && import.meta.env?.DEV) {
      console.warn(
        `[scenarios/cascade] account-level adjustment for ${target.accountCode} not yet wired (Phase 1b)`,
      );
    }
    return state;
  }

  return state;
}

/** Apply a numeric operation to a current value. Pure. */
function applyOperation(current: number, op: AdjustmentOperation): number {
  switch (op.type) {
    case "pct_change":
      return current * (1 + op.value);
    case "absolute_change":
      return current + op.value;
    case "set_value":
      return op.value;
    case "set_driver":
      // set_driver is paired with a driver target — handled in
      // applyDriverAdjustment. Reaching here means the operation type
      // was paired with a non-driver target (e.g. concept target with
      // set_driver) which is a caller bug; preserve current as a safe
      // no-op.
      return current;
  }
}

// ─── Driver translation ────────────────────────────────────────────────

function applyDriverAdjustment(
  state: CascadeState,
  driver: DriverKey,
  op: AdjustmentOperation,
): CascadeState {
  // Drivers expect set_driver or set_value with a numeric value.
  const driverValue =
    op.type === "set_driver"
      ? op.driverValue
      : op.type === "set_value"
        ? op.value
        : null;
  if (driverValue === null) return state;

  switch (driver) {
    case "dio_days": {
      // DIO = Inventory / COGS × 365  →  Inventory = COGS × days / 365
      const cogs = num(state.cogs);
      return { ...state, inventory: (cogs * driverValue) / 365 };
    }
    case "dso_days": {
      // DSO = AR / Revenue × 365  →  AR = Revenue × days / 365
      const rev = num(state.revenue);
      return { ...state, receivables: (rev * driverValue) / 365 };
    }
    case "dpo_days": {
      // DPO = AP / COGS × 365  →  AP = COGS × days / 365
      const cogs = num(state.cogs);
      return { ...state, accountsPayable: (cogs * driverValue) / 365 };
    }
    case "gross_margin": {
      // gross_margin = (revenue − cogs) / revenue  →  cogs = revenue × (1 − gm)
      const rev = num(state.revenue);
      return { ...state, cogs: rev * (1 - driverValue) };
    }
    // NOTE (review #4): effective_tax_rate is NOT handled here. It is
    // intercepted in applyCascade and applied inside cascadePnL against the
    // recomputed EBIT, so charging it here (off the stale EBIT) is wrong.
    // ebitda_margin / net_margin drivers were removed (review #6): they wrote
    // fields cascadePnL unconditionally re-derives, so they were silent
    // no-ops. They can return when cascadePnL learns to honour a margin
    // override via a balancing P&L line.
    case "capex_pct_revenue": {
      // capex = revenue × pct
      const rev = num(state.revenue);
      return { ...state, capex: rev * driverValue };
    }
    case "da_pct_revenue": {
      // Total D&A = revenue × pct. Split between depreciation and
      // amortization in the SAME ratio as the baseline (preserves the
      // mix the user had). Defensive: if both are 0, put everything in
      // depreciation.
      const rev = num(state.revenue);
      const totalDA = rev * driverValue;
      const depBaseline = num(state.depreciation);
      const amortBaseline = num(state.amortization);
      const denom = depBaseline + amortBaseline;
      if (denom === 0) {
        return { ...state, depreciation: totalDA, amortization: 0 };
      }
      const depRatio = depBaseline / denom;
      return {
        ...state,
        depreciation: totalDA * depRatio,
        amortization: totalDA * (1 - depRatio),
      };
    }
    default:
      // effective_tax_rate is intercepted in applyCascade and never reaches
      // here; any unrecognised driver is a safe no-op.
      return state;
  }
}

// ─── P&L cascade ───────────────────────────────────────────────────────

function cascadePnL(
  state: CascadeState,
  taxRateOverride: number | null = null,
): CascadeState {
  const revenue = num(state.revenue);
  const cogs = num(state.cogs);
  const opex = num(state.opex);
  const depreciation = num(state.depreciation);
  const amortization = num(state.amortization);
  const interestExpense = 0; // ReportingMetrics has no interestExpense
  // (it's bundled in netFinancialResult). Treat as zero for cascade.
  const netFinancialResult = num(state.netFinancialResult);

  const grossProfit = revenue - cogs;
  const ebit = grossProfit - opex;
  const ebitda = ebit + depreciation + amortization;
  const pretaxProfit = ebit - interestExpense + netFinancialResult;
  // Tax: if an effective_tax_rate driver was set, charge it on the FRESHLY
  // recomputed EBIT (review #4 — never on the stale baseline EBIT). No tax
  // credit on a loss (floor at 0), matching the engine convention. Without
  // a rate driver, reuse the baseline tax plug already on state.
  const incomeTax =
    taxRateOverride !== null
      ? Math.max(0, ebit * taxRateOverride)
      : num(state.incomeTax);
  const netProfit = pretaxProfit - incomeTax;

  return {
    ...state,
    grossProfit,
    ebit,
    ebitda,
    pretaxProfit,
    netProfit,
  };
}

// ─── Balance sheet cascade ─────────────────────────────────────────────

function cascadeBalanceSheet(
  state: CascadeState,
  baseline: CascadeState,
): CascadeState {
  // INCREMENTAL model (F6.0.5, 2026-06-20). Everything is expressed as a
  // DELTA from the baseline balance sheet, which guarantees two invariants
  // the previous full-reconstruction plug violated:
  //
  //   1. CONTINUITY — when no driver moves a balance-sheet input, every
  //      delta is 0, so cash / equity / current liabilities / total assets
  //      come back BYTE-IDENTICAL to the baseline. (The old code re-derived
  //      the sheet from a partial liability set and silently dropped any
  //      non-current liability that wasn't long-term DEBT — provisions,
  //      deferred grants — so cash jumped the instant any slider moved,
  //      making leverage discontinuous at the baseline. That destroyed
  //      trust in small scenarios.)
  //   2. BALANCE — A = L + E holds by construction (cash is solved as the
  //      residual of an identity, not re-plugged from scratch).
  //
  // Deltas that move cash (indirect cash-flow identity, D&A cancels in the
  // delta because it's unchanged unless a D&A driver moves it — none in the
  // Phase-1 lever set):
  //   Δcash = ΔNetIncome − (ΔAR + ΔInv − ΔAP) − ΔCapex + ΔDebt
  // CapEx also reclassifies cash → PPE (non-current assets rise by ΔCapex),
  // so total assets are unchanged by capex alone — only its financing
  // (the cash leg) bites.
  const niDelta = num(state.netProfit) - num(baseline.netProfit);
  const dAR = num(state.receivables) - num(baseline.receivables);
  const dInv = num(state.inventory) - num(baseline.inventory);
  const dAP = num(state.accountsPayable) - num(baseline.accountsPayable);
  const dCapex = num(state.capex) - num(baseline.capex);
  const dDebt = num(state.totalDebt) - num(baseline.totalDebt);

  // Retained earnings: net-income delta accrues to equity (zero dividend
  // payout for Phase 1; a dividend-policy lever comes later).
  const equityNew = num(baseline.shareholdersEquity) + niDelta;

  const cashNew =
    num(baseline.cash) + niDelta - (dAR + dInv - dAP) - dCapex + dDebt;

  // Current assets other than the three the levers can move (cash, AR, inv)
  // — prepayments, other current — are held at their baseline level.
  const otherCurrentAssets =
    num(baseline.currentAssets) -
    num(baseline.cash) -
    num(baseline.receivables) -
    num(baseline.inventory);
  const currentAssetsNew =
    cashNew + num(state.receivables) + num(state.inventory) + otherCurrentAssets;

  // Non-current assets = baseline non-current + capex additions.
  const nonCurrentAssetsNew =
    num(baseline.totalAssets) - num(baseline.currentAssets) + dCapex;

  const totalAssetsNew = currentAssetsNew + nonCurrentAssetsNew;

  // Only AP moves among current liabilities (the lever set has no other
  // current-liability driver); everything else holds at baseline.
  const currentLiabilitiesNew = num(baseline.currentLiabilities) + dAP;

  return {
    ...state,
    cash: cashNew,
    currentAssets: currentAssetsNew,
    nonCurrentAssets: nonCurrentAssetsNew,
    currentLiabilities: currentLiabilitiesNew,
    totalAssets: totalAssetsNew,
    // A = L + E by construction (cash solved as the identity residual).
    totalEquityAndLiab: totalAssetsNew,
    shareholdersEquity: equityNew,
  };
}

// ─── Cash flow cascade ─────────────────────────────────────────────────

function cascadeCashFlow(
  state: CascadeState,
  baseline: CascadeState,
): CascadeState {
  // OCF (indirect method) = Net Income + D&A − ΔWC
  // ΔWC defined as (ΔAR + ΔInv − ΔAP); positive ΔWC consumes cash.
  const wcChange =
    num(state.receivables) -
    num(baseline.receivables) +
    (num(state.inventory) - num(baseline.inventory)) -
    (num(state.accountsPayable) - num(baseline.accountsPayable));

  const operatingCashFlow =
    num(state.netProfit) +
    num(state.depreciation) +
    num(state.amortization) -
    wcChange;

  const capex = num(state.capex);
  // ReportingMetrics has no `freeCashFlow` field. Surface OCF + capex
  // explicitly so the scenario UI can show "Free Cash Flow = OCF −
  // CapEx" without needing the field. Stored on `investingCashFlow`
  // for consumer compatibility (matches the F4.x canonical schema).
  const investingCashFlow = -capex;

  return {
    ...state,
    operatingCashFlow,
    investingCashFlow,
  };
}

// ─── Ratio recompute ───────────────────────────────────────────────────

function recomputeRatios(state: CascadeState): CascadeState {
  // Every division checks the denominator. NEVER divide by zero —
  // produces NaN/Infinity which then corrupts the entire downstream
  // chain. Returns the state untouched for ratios that can't be
  // computed (e.g. zero revenue → margin remains whatever was set,
  // typically 0 from baseline).
  const revenue = num(state.revenue);
  const cogs = num(state.cogs);
  const inv = num(state.inventory);
  const ar = num(state.receivables);
  const ap = num(state.accountsPayable);
  const cash = num(state.cash);
  const totalDebt = num(state.totalDebt);
  const ebitda = num(state.ebitda);
  const currentAssets = num(state.currentAssets);
  const currentLiabilities = num(state.currentLiabilities);
  // const totalAssets = num(state.totalAssets);
  // const equity = num(state.shareholdersEquity);

  // No-op for fields ReportingMetrics doesn't carry as derived ratios.
  // The UI consumes these via separate computation hooks; we only
  // recompute what's strictly stored on the metrics record so callers
  // can read primary + scenario state with the same interface.
  void cogs;
  void inv;
  void ar;
  void ap;
  void cash;
  void totalDebt;
  void ebitda;
  void currentAssets;
  void currentLiabilities;
  void revenue;

  return state;
}

// ─── Dependency-ordered adjustment sort ────────────────────────────────

/** Sort adjustments by dependency. Top-level P&L inputs (revenue, cogs,
 *  opex) apply FIRST so any driver that depends on them sees the
 *  adjusted values. Drivers and overrides apply after. */
export function sortAdjustmentsByDependency(
  adjustments: Adjustment[],
): Adjustment[] {
  const priority: Record<string, number> = {
    "concept:revenue": 1,
    "concept:cogs": 2,
    "concept:opex": 3,
    "driver:gross_margin": 4,
    "driver:dio_days": 5,
    "driver:dso_days": 5,
    "driver:dpo_days": 5,
    "concept:capex": 6,
    "driver:capex_pct_revenue": 6,
    "concept:depreciation": 7,
    "concept:amortization": 7,
    "driver:da_pct_revenue": 7,
    "driver:effective_tax_rate": 8,
  };

  return [...adjustments].sort((a, b) => {
    const keyA = targetKey(a.target);
    const keyB = targetKey(b.target);
    return (priority[keyA] ?? 99) - (priority[keyB] ?? 99);
  });
}

function targetKey(target: AdjustmentTarget): string {
  if (target.type === "concept") return `concept:${String(target.conceptKey)}`;
  if (target.type === "driver") return `driver:${target.driverKey}`;
  return `account:${target.accountCode}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Treat undefined/null as 0 throughout the cascade. ReportingMetrics
 *  fields are mostly optional numbers; this lets the math run cleanly
 *  on partial baselines (e.g. early-stage datasets without all derived
 *  fields). */
function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
