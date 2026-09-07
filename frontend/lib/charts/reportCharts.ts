// THE REPORT'S CHARTS — derivation, not decoration.
//
// Every block below is built from the SERVED envelope: `assembled_cf`,
// `assembled_bands`, the canonical balance sheet through the servedFacts
// gateway, the ratio bundle the document already prints, and the credit
// reader's own components. This module computes no financial quantity of
// its own beyond adding up figures the engine emitted, and it never
// invents an input.
//
// ── WHAT IS DRAWN AND WHAT IS A GAP CARD, MEASURED ─────────────────────
// On all four committed firm books (agras / carniprod / realestate /
// retail) the envelope carries NO prior period and NO history:
//
//   statements.prior              → absent on 4 of 4
//   statements.historicalPeriods  → absent on 4 of 4
//
// So the EBITDA bridge, the net-debt walk and the revenue/margin trend
// CANNOT be drawn from these books, and this module does not pretend
// otherwise: they render `gapCard()`, which names the missing input and
// what would supply it. Drawing a one-bar "trend", or a bridge whose
// only step is the current period, would be a chart that looks like a
// measurement and is not one — the exact failure ABSENT ≠ ZERO forbids.
// The moment a period arrives with a prior attached, the same code
// draws; `reportCharts.test.ts` proves both halves on a fixture built by
// attaching a real prior to a real book.

import type { CreditScoreResult } from "../financialValuation";
import type { RatioBundle, Ratio, Statements } from "../financialReport";
import { factsFrom } from "../servedFacts";
import {
  bandTracks,
  contributionBars,
  stackedColumns,
  waterfall,
  type BandTrackRow,
  type BandZone,
  type ContribRow,
} from "./primitives";
import { gapCard, rowsTable, type ChartBlock, type ChartRow } from "./svg";

/** How this module prints money — injected, never re-spelled here. The
 *  document's own `money()` is passed in, so a chart label and a
 *  statement cell cannot format the same figure two ways. */
export type MoneyFmt = (v: number | null | undefined) => string;

export interface ChartInputs {
  s: Statements;
  ratios: RatioBundle;
  credit: CreditScoreResult;
  money: MoneyFmt;
  /** True when the industry signal disputes the workspace setting. Any
   *  chart whose calibration is sector-derived must withhold. */
  sectorBlocked: boolean;
}

// ── served-envelope readers ────────────────────────────────────────────

function cfBlock(s: Statements): Record<string, unknown> | null {
  const cf = (s as Statements & { assembled_cf?: Record<string, unknown> }).assembled_cf;
  if (!cf || typeof cf !== "object") return null;
  return cf as Record<string, unknown>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface ServedBands {
  bands: Record<string, { direction?: string; watch?: number; healthy?: number; strong?: number }>;
  source: string | null;
  disclosure: string | null;
}

export function readBands(s: Statements): ServedBands | null {
  const raw = (s as Statements & { assembled_bands?: unknown }).assembled_bands;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const b = o.bands;
  if (!b || typeof b !== "object") return null;
  return {
    bands: b as ServedBands["bands"],
    source: typeof o.source === "string" ? o.source : null,
    disclosure: typeof o.disclosure === "string" ? o.disclosure : null,
  };
}

function ratioNamed(r: RatioBundle, key: string): Ratio | undefined {
  return [r.liquidity, r.profitability, r.leverage, r.coverage, r.efficiency]
    .flat()
    .find((x) => x.key === key);
}

// ── 1. EBITDA BRIDGE (the signature chart) ─────────────────────────────

export function ebitdaBridge(i: ChartInputs): ChartBlock {
  const prior = i.s.prior;
  const title = "EBITDA bridge — prior period to current";
  if (!prior) {
    const absence = {
      missing: ["prior-period profit & loss (`statements.prior`)"],
      because:
        "A bridge is the difference between two periods. This envelope carries one period, so " +
        "there is no prior EBITDA to bridge from and no volume, price, cost-of-sales or " +
        "operating-cost step to attribute a movement to.",
      toFix:
        "Upload the prior period's trial balance to the same workspace; the engine attaches it " +
        "as `statements.prior` and every step below is then read off the two class-6/7 movements.",
    };
    return {
      id: "chart-ebitda-bridge",
      title,
      status: "absent",
      svg: gapCard(title, absence),
      rows: [],
      table: "",
      caption:
        "Not charted: this period has no prior period attached. A single-period bar is not a bridge.",
      absence,
    };
  }

  const ap = (i.s as Statements & { assembled_pl?: Record<string, number> }).assembled_pl ?? {};
  const cur = num(ap.ebitda_statutory);
  const pIs = prior.incomeStatement;
  const priorEbitda =
    pIs.revenue - pIs.costOfGoodsSold - pIs.operatingExpenses + (pIs.otherIncome ?? 0);
  // Every step is a difference of two SERVED lines; nothing is modelled.
  const dRevenue = i.s.incomeStatement.revenue - pIs.revenue;
  const dCogs = -(i.s.incomeStatement.costOfGoodsSold - pIs.costOfGoodsSold);
  const dOpex = -(i.s.incomeStatement.operatingExpenses - pIs.operatingExpenses);
  const dOther = (i.s.incomeStatement.otherIncome ?? 0) - (pIs.otherIncome ?? 0);
  const stepped = priorEbitda + dRevenue + dCogs + dOpex + dOther;
  const unexplained = (cur ?? stepped) - stepped;

  const rows: ChartRow[] = [
    { key: "prior", label: `EBITDA ${prior.periodLabel}`, value: priorEbitda, printed: i.money(priorEbitda), source: "prior 70x − 60x/61x/62x/64x", kind: "anchor" },
    { key: "rev", label: "Revenue", value: dRevenue, printed: i.money(dRevenue), source: "70x movement", kind: "delta" },
    { key: "cogs", label: "Cost of sales", value: dCogs, printed: i.money(dCogs), source: "60x movement", kind: "delta" },
    { key: "opex", label: "Operating costs", value: dOpex, printed: i.money(dOpex), source: "61x/62x/64x/65x movement", kind: "delta" },
    { key: "other", label: "Other income", value: dOther, printed: i.money(dOther), source: "758/781 movement", kind: "delta" },
  ];
  if (Math.abs(unexplained) > 0.005) {
    rows.push({
      key: "unexplained",
      label: "Unattributed",
      value: unexplained,
      printed: i.money(unexplained),
      source: "residual vs assembled_pl.ebitda_statutory",
      kind: "delta",
      breach: true,
    });
  }
  rows.push({
    key: "cur",
    label: `EBITDA ${i.s.periodLabel}`,
    value: cur ?? stepped,
    printed: i.money(cur ?? stepped),
    source: "assembled_pl.ebitda_statutory",
    kind: "anchor",
  });

  return {
    id: "chart-ebitda-bridge",
    title,
    status: "drawn",
    svg: waterfall({ id: "chart-ebitda-bridge", title, unit: i.s.currency, rows }),
    rows,
    table: rowsTable(rows, i.s.currency),
    caption:
      Math.abs(unexplained) > 0.005
        ? `The steps do not reach the current statutory EBITDA: ${i.money(unexplained)} is unattributed and is drawn as its own step rather than folded into one of the named ones.`
        : "Each step is the movement in one class-6/7 group between the two periods; the steps sum to the current statutory EBITDA.",
  };
}

// ── 2. CASH WALK ───────────────────────────────────────────────────────

export function cashWalk(i: ChartInputs): ChartBlock {
  const title = "Cash walk — where the period's cash came from and went";
  const cf = cfBlock(i.s);
  const before = cf ? num(cf.cf_before_wc) : null;
  const wc = cf ? num(cf.working_capital_change) : null;
  const inv = cf ? num(cf.cash_from_investing) : null;
  const fin = cf ? num(cf.cash_from_financing) : null;
  const net = cf ? num(cf.net_change_in_cash) : null;
  if (before === null || wc === null || inv === null || fin === null || net === null) {
    const absence = {
      missing: ["`assembled_cf` (cf_before_wc, working_capital_change, cash_from_investing, cash_from_financing, net_change_in_cash)"],
      because:
        "The cash walk is the engine's own indirect-method reconstruction. This envelope did not carry it, and rebuilding it in the browser from the balance sheet would be a second, unreconciled cash-flow statement.",
      toFix: "Re-run the period through the pipeline so `/api/period` serves `assembled_cf`.",
    };
    return { id: "chart-cash-walk", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: the served envelope carries no cash-flow block.", absence };
  }
  const approx = cf !== null && cf.is_approximated === true;
  const rows: ChartRow[] = [
    { key: "before", label: "Cash before working capital", value: before, printed: i.money(before), source: "assembled_cf.cf_before_wc", kind: "anchor", approximated: approx },
    { key: "wc", label: "Working capital", value: wc, printed: i.money(wc), source: "assembled_cf.working_capital_change", kind: "delta", approximated: approx },
    { key: "inv", label: "Investing", value: inv, printed: i.money(inv), source: "assembled_cf.cash_from_investing", kind: "delta", approximated: approx },
    { key: "fin", label: "Financing", value: fin, printed: i.money(fin), source: "assembled_cf.cash_from_financing", kind: "delta", approximated: approx },
    { key: "net", label: "Net change in cash", value: net, printed: i.money(net), source: "assembled_cf.net_change_in_cash", kind: "anchor", approximated: approx },
  ];
  // THE TIE-OUT, STATED. `net_change_in_cash` is a movement; the period
  // also carries the closing balance the ledger actually shows. On the
  // agras book those two imply a NEGATIVE opening cash balance, which is
  // not a thing a bank account does — so the caption says so rather than
  // letting a clean-looking waterfall imply the walk reconciles.
  const closing = cf ? num(cf.closing_cash_actual) : null;
  const impliedOpening = closing !== null ? closing - net : null;
  const tie =
    closing === null
      ? ""
      : impliedOpening !== null && impliedOpening < 0
        ? ` Period-end cash is ${i.money(closing)}; against a net movement of ${i.money(net)} that implies an opening balance of ${i.money(impliedOpening)}, which cannot be right — the walk and the closing balance are not reconciled by this extract.`
        : ` Period-end cash is ${i.money(closing)}, implying an opening balance of ${i.money(impliedOpening)}.`;
  return {
    id: "chart-cash-walk",
    title,
    status: "drawn",
    svg: waterfall({ id: "chart-cash-walk", title, unit: i.s.currency, rows }),
    rows,
    table: rowsTable(rows, i.s.currency),
    caption:
      (approx
        ? "The engine flags this reconstruction as approximated (`assembled_cf.is_approximated`), which is why the bars are hatched: the working-capital and investing steps are inferred from period-end balances, not from movement detail."
        : "Each step is a served cash-flow aggregate; the steps sum to the net movement.") + tie,
  };
}

// ── 3. NET DEBT WALK ───────────────────────────────────────────────────

export function netDebtWalk(i: ChartInputs): ChartBlock {
  const title = "Net debt walk";
  if (!i.s.prior) {
    const absence = {
      missing: ["prior-period balance sheet (`statements.prior.balanceSheet`)"],
      because:
        "A net-debt walk moves from an opening net-debt position to a closing one. With one balance sheet there is an opening figure for neither debt nor cash, and the drawdown and repayment lines the cash-flow block carries cannot be checked against a movement that has no start.",
      toFix: "Attach the prior period; the walk is then opening net debt → drawdowns → repayments → cash movement → closing net debt.",
    };
    return { id: "chart-net-debt-walk", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: no opening balance sheet in this envelope.", absence };
  }
  const p = i.s.prior.balanceSheet;
  const c = i.s.balanceSheet;
  const openNet = p.shortTermDebt + p.longTermDebt - p.cash;
  const closeNet = c.shortTermDebt + c.longTermDebt - c.cash;
  const dSt = c.shortTermDebt - p.shortTermDebt;
  const dLt = c.longTermDebt - p.longTermDebt;
  const dCash = -(c.cash - p.cash);
  const rows: ChartRow[] = [
    { key: "open", label: `Net debt ${i.s.prior.periodLabel}`, value: openNet, printed: i.money(openNet), source: "prior 519/162/167 − 512/531", kind: "anchor" },
    { key: "st", label: "Short-term debt", value: dSt, printed: i.money(dSt), source: "519 movement", kind: "delta" },
    { key: "lt", label: "Long-term debt", value: dLt, printed: i.money(dLt), source: "162/167 movement", kind: "delta" },
    { key: "cash", label: "Cash", value: dCash, printed: i.money(dCash), source: "512/531 movement", kind: "delta" },
    { key: "close", label: `Net debt ${i.s.periodLabel}`, value: closeNet, printed: i.money(closeNet), source: "519/162/167 − 512/531", kind: "anchor" },
  ];
  return {
    id: "chart-net-debt-walk",
    title,
    status: "drawn",
    svg: waterfall({ id: "chart-net-debt-walk", title, unit: i.s.currency, rows }),
    rows,
    table: rowsTable(rows, i.s.currency),
    caption: "Movements in the three balance-sheet lines net debt is made of; the steps sum to the closing position.",
  };
}

// ── 4. BALANCE-SHEET COMPOSITION ───────────────────────────────────────

export function bsComposition(i: ChartInputs): ChartBlock {
  const title = "Where the money is, and whose it is";
  const sf = factsFrom(i.s);
  const bs = i.s.balanceSheet;
  const ta = sf.totalAssets();
  const tel = sf.equityPlusLiabilities();
  if (ta === null || tel === null) {
    const absence = {
      missing: ["balance-sheet totals (`servedFacts.totalAssets` / `equityPlusLiabilities`)"],
      because: "The composition is a share of a total; without the served totals there is nothing to take a share of.",
      toFix: "Re-run the period so the canonical balance sheet is served.",
    };
    return { id: "chart-bs-composition", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: no served balance-sheet totals.", absence };
  }
  const assets: ChartRow[] = [
    { key: "ppe", label: "PP&E", value: bs.propertyPlantEquipment, printed: i.money(bs.propertyPlantEquipment), source: "21x/23x net of 28x" },
    { key: "intang", label: "Intangibles", value: bs.intangibles, printed: i.money(bs.intangibles), source: "20x net of 280" },
    { key: "othernc", label: "Other non-current", value: bs.otherNonCurrentAssets, printed: i.money(bs.otherNonCurrentAssets), source: "26x" },
    { key: "inv", label: "Inventory", value: bs.inventory, printed: i.money(bs.inventory), source: "3xx net of 39x" },
    { key: "ar", label: "Receivables", value: bs.accountsReceivable, printed: i.money(bs.accountsReceivable), source: "411/413/4xx net of 49x" },
    { key: "cash", label: "Cash", value: bs.cash, printed: i.money(bs.cash), source: "512/531/541" },
    { key: "othca", label: "Other current", value: bs.otherCurrentAssets, printed: i.money(bs.otherCurrentAssets), source: "409/471" },
  ].filter((r) => Math.abs(r.value ?? 0) > 0.005);
  const funding: ChartRow[] = [
    { key: "eq", label: "Equity", value: sf.totalEquity(), printed: i.money(sf.totalEquity()), source: "101/104/105/106/117/121" },
    { key: "ltd", label: "Long-term debt", value: bs.longTermDebt, printed: i.money(bs.longTermDebt), source: "162/167/168" },
    { key: "othnc", label: "Other non-current liab.", value: bs.otherNonCurrentLiabilities, printed: i.money(bs.otherNonCurrentLiabilities), source: "15x/475/478" },
    { key: "std", label: "Short-term debt", value: bs.shortTermDebt, printed: i.money(bs.shortTermDebt), source: "519" },
    { key: "ap", label: "Payables", value: bs.accountsPayable, printed: i.money(bs.accountsPayable), source: "401/403/404/408" },
    { key: "othcl", label: "Other current liab.", value: bs.otherCurrentLiabilities, printed: i.money(bs.otherCurrentLiabilities), source: "42x/43x/44x/419/472" },
  ].filter((r) => Math.abs(r.value ?? 0) > 0.005);
  // The letter key the drawing puts on a slice too thin to hold its name.
  // One alphabet per column, matching the segment order in each stack.
  const keyed = (rows: ChartRow[], side: string): ChartRow[] =>
    rows.map((r, ix) => ({ ...r, label: `${side} ${String.fromCharCode(65 + ix)} · ${r.label}` }));
  const rows = [...keyed(assets, "Assets"), ...keyed(funding, "Funding")];
  return {
    id: "chart-bs-composition",
    title,
    status: "drawn",
    svg: stackedColumns({
      id: "chart-bs-composition",
      title,
      columns: [
        { label: "Assets", totalPrinted: i.money(ta), segments: assets },
        { label: "Equity & liabilities", totalPrinted: i.money(tel), segments: funding },
      ],
    }),
    rows,
    table: rowsTable(rows, i.s.currency),
    caption:
      "Stacked, not pies: the two columns are compared against each other, and comparing two pies is comparing angles. A slice too thin to hold its name carries its letter key instead; the table below names every slice, its figure and its accounts under the same letter.",
  };
}

// ── 5. WORKING-CAPITAL CYCLE ───────────────────────────────────────────

export function workingCapitalCycle(i: ChartInputs): ChartBlock {
  const title = "Working-capital cycle — DSO + DIO − DPO = CCC";
  const keys = ["dso", "dio", "dpo", "ccc"] as const;
  const found = keys.map((k) => ratioNamed(i.ratios, k));
  const missing = keys.filter((k, ix) => found[ix] === undefined || found[ix]?.value === null);
  if (missing.length > 0) {
    const absence = {
      missing: missing.map((k) => k.toUpperCase()),
      because:
        "The cycle is a sum of four day-counts; a bar drawn with one of them silently at zero would shorten the cycle rather than admit a gap.",
      toFix:
        "The absent term needs its input — receivables and revenue for DSO, inventory and cost of sales for DIO, payables and cost of sales for DPO.",
    };
    return { id: "chart-wc-cycle", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: `Not charted: ${missing.join(", ").toUpperCase()} could not be computed for this period.`, absence };
  }
  const days = (v: number): string => `${v.toFixed(1)} days`;
  const dso = found[0] as Ratio, dio = found[1] as Ratio, dpo = found[2] as Ratio, ccc = found[3] as Ratio;
  const rows: ChartRow[] = [
    { key: "dso", label: "DSO", value: dso.value, printed: days(dso.value as number), source: "receivables ÷ revenue × days", kind: "anchor" },
    { key: "dio", label: "plus DIO", value: dio.value, printed: days(dio.value as number), source: "inventory ÷ cost of sales × days", kind: "delta" },
    { key: "dpo", label: "less DPO", value: -(dpo.value as number), printed: days(-(dpo.value as number)), source: "payables ÷ cost of sales × days", kind: "delta" },
    { key: "ccc", label: "equals CCC", value: ccc.value, printed: days(ccc.value as number), source: "DSO + DIO − DPO", kind: "anchor", breach: ccc.verdict === "critical" },
  ];
  const stepped = (dso.value as number) + (dio.value as number) - (dpo.value as number);
  const drift = (ccc.value as number) - stepped;
  return {
    id: "chart-wc-cycle",
    title,
    status: "drawn",
    svg: waterfall({ id: "chart-wc-cycle", title, unit: "days", rows }),
    rows,
    table: rowsTable(rows, "days"),
    caption:
      Math.abs(drift) > 0.05
        ? `The three terms sum to ${days(stepped)}; the served cycle is ${days(ccc.value as number)} — a ${days(drift)} difference, which means the four figures were not all computed off the same day count.`
        : `Each bar is one term of the identity above; the three terms sum to the served cycle of ${days(ccc.value as number)}.`,
  };
}

// ── 6. CREDIT SCORE CONTRIBUTIONS ──────────────────────────────────────

export function creditContributions(i: ChartInputs): ChartBlock {
  const title = "What the credit score is made of";
  const comps = i.credit.components;
  if (comps.length === 0) {
    const absence = {
      missing: ["credit component breakdown"],
      because: "The composite was not accompanied by its weighted terms, so there is nothing to attribute the score to.",
      toFix: "Re-run the period so the credit envelope serves `subscores` and `composite_weights`.",
    };
    return { id: "chart-credit-contrib", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: no component breakdown behind the composite.", absence };
  }
  const rows: ContribRow[] = comps.map((c) => {
    const ceiling = c.weight === null ? null : c.weight * 100;
    return {
      key: c.label,
      // "Altman Z\u2033-Score" is the name of a MEASURE, and this row prints
      // the measure's weighted CONTRIBUTION (2.4 points), not the measure
      // (0.22). Reusing the name put a second number under it in the
      // workbook — one name, two formulas, which is the defect R1 names.
      // `Term:` says what the figure is: a term of the composite.
      label: `Term: ${c.label}`,
      value: c.contribution,
      printed: c.contribution === null ? "not reported" : c.contribution.toFixed(1),
      ceiling,
      ceilingPrinted: ceiling === null ? "not reported" : ceiling.toFixed(1),
      // The CEILING is drawn on the bar ("of 20.0"), so it has to be
      // printed in a table too — the same law every other figure obeys.
      source:
        c.weight === null
          ? "weight not reported"
          : `weight ${(c.weight * 100).toFixed(0)}% · ceiling ${(c.weight * 100).toFixed(1)}`,
      breach: c.contribution !== null && ceiling !== null && ceiling > 0 && c.contribution / ceiling < 0.34,
    };
  });
  const lost = rows
    .filter((r) => r.value !== null && r.ceiling !== null)
    .reduce((a, r) => a + ((r.ceiling as number) - (r.value as number)), 0);
  return {
    id: "chart-credit-contrib",
    title,
    status: "drawn",
    svg: contributionBars("chart-credit-contrib", title, rows),
    rows,
    table: rowsTable(rows, "points"),
    caption: `The pale bar is the most each term could contribute at its weight; the filled bar is what it did contribute. ${lost.toFixed(1)} points of the composite were given up across the seven terms, and the marked rows are the ones that gave up more than two-thirds of their own ceiling.`,
  };
}

// ── 7. RATIO BAND TRACKS ───────────────────────────────────────────────
//
// The chart that replaces a word chip. The zones come from the engine's
// `assembled_bands`; nothing here holds a threshold.
//
// AND IT PRINTS WHERE THE BANDS CAME FROM. `_band_definitions()` in
// `src/engine/country_packs/ro_romania/chart_of_accounts.py` returns
// `source: "general_sme_fallback"` with a disclosure string, and its own
// docstring says a verdict on fallback bands "must be visually
// distinguishable from one on industry-specific bands". Measured on
// 2026-09-07: no frontend file read `source` or `disclosure` at all — so
// every Healthy / Watch / Critical badge in this document was banded on
// general-SME defaults and said nothing about it.

/**
 * The zones for one ratio key, from the SERVED band definition — the one
 * construction the full track and the card-scale chip both use, so the
 * two can never place the same ratio differently.
 */
export function zonesForKey(
  served: ServedBands,
  key: string,
  value: number | null,
): { zones: BandZone[]; thresholds: number[]; higher: boolean } | null {
  const def = served.bands[key];
  if (!def) return null;
  const higher = def.direction !== "lower";
  const th = [def.watch, def.healthy, def.strong].filter((x): x is number => typeof x === "number");
  if (th.length < 2) return null;
  const sorted = [...th].sort((a, b) => a - b);
  const pad = (sorted[sorted.length - 1] - sorted[0]) * 0.35 || 1;
  const lo = Math.min(sorted[0] - pad, value ?? sorted[0] - pad);
  const hi = Math.max(sorted[sorted.length - 1] + pad, value ?? sorted[sorted.length - 1] + pad);
  const names = higher
    ? ["critical", "watch", "healthy", "strong"]
    : ["strong", "healthy", "watch", "critical"];
  const edges = [lo, ...sorted, hi];
  const zones: BandZone[] = [];
  for (let z = 0; z < edges.length - 1; z++) {
    const label = names[Math.min(z, names.length - 1)];
    zones.push({ from: edges[z], to: edges[z + 1], label, breachZone: label === "critical" });
  }
  return { zones, thresholds: sorted, higher };
}

const TRACK_KEYS = ["current_ratio", "quick_ratio", "debt_to_ebitda", "interest_coverage", "dscr", "ccc"];

export function ratioBandTracks(i: ChartInputs): ChartBlock {
  const title = "Measured against the bands the verdicts were decided by";
  const served = readBands(i.s);
  if (!served) {
    const absence = {
      missing: ["`assembled_bands`"],
      because: "A band track without served bands would be this document inventing its own thresholds — which is exactly the second authority the verdicts must not acquire.",
      toFix: "Re-run the period so `/api/period` serves `assembled_bands`.",
    };
    return { id: "chart-band-tracks", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: the envelope carries no band definitions.", absence };
  }
  // A SECTOR-CALIBRATED band under a disputed industry is withheld — the
  // same rule the profile-gated recommendations follow. Today the engine
  // serves `general_sme_fallback`, which is sector-NEUTRAL and therefore
  // survives the block; the branch is here so it stops surviving the day
  // the engine starts calibrating.
  if (i.sectorBlocked && served.source !== null && served.source !== "general_sme_fallback") {
    const absence = {
      missing: [`sector-calibrated bands (source: ${served.source})`],
      because: "The account mix and the workspace industry setting disagree, and these bands are calibrated to the setting. A track drawn against them would grade this company on another sector's distribution.",
      toFix: "Confirm the industry in the workspace; the tracks return with the bands for the confirmed sector.",
    };
    return { id: "chart-band-tracks", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Withheld: the bands are sector-calibrated and the sector is unconfirmed.", absence };
  }

  const tracks: BandTrackRow[] = [];
  const rows: ChartRow[] = [];
  for (const key of TRACK_KEYS) {
    const rt = ratioNamed(i.ratios, key);
    if (!rt) continue;
    const built = zonesForKey(served, key, rt.value);
    if (!built) continue;
    const { zones, thresholds: sorted, higher } = built;
    const unit = rt.unit === "days" ? "d" : rt.unit === "%" ? "%" : "×";
    const spell = (v: number): string => (rt.unit === "days" ? `${v.toFixed(0)}d` : `${v.toFixed(2)}${unit}`);
    tracks.push({
      key,
      label: rt.label,
      value: rt.value,
      printed: rt.value === null ? "not reported" : spell(rt.value),
      // SHORT, and deliberately not the formula. The formula is a
      // sentence — on the quick-ratio row it is 195 characters — and
      // drawing it under a 214 px label column pushed it 11 px past the
      // viewBox and across the track beside it. Measured in a browser on
      // the agras export. The formula has two homes already: the ratio
      // card above and the provenance card behind every figure.
      source: higher ? "higher is better" : "lower is better",
      breach: rt.verdict === "critical",
      zones,
      ticks: sorted.map((v) => ({ at: v, printed: spell(v) })),
    });
    rows.push({
      key,
      label: rt.label,
      value: rt.value,
      printed: rt.value === null ? "not reported" : spell(rt.value),
      source: `bands: ${sorted.map(spell).join(" / ")} (${higher ? "higher is better" : "lower is better"})`,
      breach: rt.verdict === "critical",
    });
  }
  if (tracks.length === 0) {
    const absence = {
      missing: ["a ratio with both a value and a served band"],
      because: "None of the tracked ratios resolved on this period, so there is nothing to place on a track.",
      toFix: "The absent ratios need their inputs; see the refusal note printed on each ratio card.",
    };
    return { id: "chart-band-tracks", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: no tracked ratio resolved on this period.", absence };
  }
  const disclosure =
    served.source === "general_sme_fallback"
      ? " These are GENERAL-SME bands, not calibrated to this company's industry: the engine serves them as `general_sme_fallback`, and every Healthy / Watch / Critical verdict in this document was decided by them."
      : served.source
        ? ` Band source: ${served.source}.`
        : "";
  return {
    id: "chart-band-tracks",
    title,
    status: "drawn",
    svg: bandTracks("chart-band-tracks", title, tracks),
    rows,
    table: rowsTable(rows, "measured"),
    caption:
      "Each track is one ratio placed on the bands its verdict was decided by, so the distance to the next band is visible rather than compressed into a word." +
      disclosure,
  };
}

// ── 8. COVENANT HEADROOM ───────────────────────────────────────────────

export function covenantHeadroom(i: ChartInputs): ChartBlock {
  const title = "Covenant headroom";
  const absence = {
    missing: ["the facility's covenant terms (tested ratio, threshold, test date, cure rights)"],
    because:
      "Nothing in the envelope carries a covenant. Drawing headroom against a benchmark band instead would put a lender's word on a threshold no lender set — the reader would take it for the facility's own test.",
    toFix:
      "Enter the covenant package for each facility; headroom is then the tested ratio against its own contractual threshold, not against a benchmark.",
  };
  return {
    id: "chart-covenant-headroom",
    title,
    status: "absent",
    svg: gapCard(title, absence),
    rows: [],
    table: "",
    caption: "Not charted: no covenant terms are on file for this entity. The band tracks above are benchmarks, not covenants.",
    absence,
  };
}

// ── 9. ASSET AGE ───────────────────────────────────────────────────────

export function assetAge(i: ChartInputs): ChartBlock {
  const title = "Asset age — accumulated depreciation against gross PP&E";
  const bs = (i.s as Statements & { assembled_bs?: Record<string, number> }).assembled_bs ?? {};
  const gross = num(bs.ppe_gross);
  const accum = num(bs.ppe_accumulated_depreciation);
  if (gross === null || accum === null || gross === 0) {
    const absence = {
      missing: [
        gross === null || gross === 0 ? "gross PP&E (`assembled_bs.ppe_gross`, class 21x before contra)" : "",
        accum === null ? "accumulated depreciation (`assembled_bs.ppe_accumulated_depreciation`, class 28x)" : "",
      ].filter((x) => x !== ""),
      because:
        "Asset age is the contra account over the gross cost. The envelope serves PP&E NET of depreciation only — one number where the ratio needs two — so the age cannot be recovered from it at any level of effort.",
      toFix:
        "The trial balance carries both sides (21x debit, 28x credit); the assembler needs to serve them separately rather than only their difference.",
    };
    return { id: "chart-asset-age", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: the served balance sheet carries PP&E net only, so gross cost and accumulated depreciation cannot be separated.", absence };
  }
  const pctUsed = (accum / gross) * 100;
  const track: BandTrackRow = {
    key: "asset_age",
    label: "Depreciated share of gross PP&E",
    value: pctUsed,
    printed: `${pctUsed.toFixed(1)}%`,
    source: "28x ÷ 21x",
    breach: pctUsed > 70,
    zones: [
      { from: 0, to: 40, label: "young" },
      { from: 40, to: 55, label: "mid-life" },
      { from: 55, to: 70, label: "ageing" },
      { from: 70, to: 100, label: "replacement due", breachZone: true },
    ],
    ticks: [
      { at: 40, printed: "40.0%" },
      { at: 55, printed: "55.0%" },
      { at: 70, printed: "70.0%" },
    ],
  };
  const rows: ChartRow[] = [
    { key: "gross", label: "Gross PP&E", value: gross, printed: i.money(gross), source: "assembled_bs.ppe_gross (21x)" },
    { key: "accum", label: "Accumulated depreciation", value: accum, printed: i.money(accum), source: "assembled_bs.ppe_accumulated_depreciation (28x)" },
    { key: "share", label: "Depreciated share", value: pctUsed, printed: `${pctUsed.toFixed(1)}%`, source: "28x ÷ 21x; zones 40.0% / 55.0% / 70.0%", breach: pctUsed > 70 },
  ];
  return {
    id: "chart-asset-age",
    title,
    status: "drawn",
    svg: bandTracks("chart-asset-age", title, [track]),
    rows,
    table: rowsTable(rows, "measured"),
    caption: "The share of the asset base already written off. The zones are age reads, not a benchmark: they say how much life the book has consumed, not how the company compares to anyone.",
  };
}

// ── 10. REVENUE & MARGIN TREND ─────────────────────────────────────────

export function revenueMarginTrend(i: ChartInputs): ChartBlock {
  const title = "Revenue and margin trend";
  const hist = i.s.historicalPeriods ?? [];
  if (hist.length === 0 && !i.s.prior) {
    const absence = {
      missing: ["prior periods (`statements.historicalPeriods` / `statements.prior`)"],
      because:
        "A trend needs at least two observations. This envelope carries one, and a single point drawn on a time axis reads as a flat line — a claim about direction the data cannot support.",
      toFix: "Upload earlier periods to this workspace; the trend draws from two observations onward.",
    };
    return { id: "chart-revenue-trend", title, status: "absent", svg: gapCard(title, absence), rows: [], table: "", caption: "Not charted: one period only. A single point is not a trend.", absence };
  }
  const periods = [...hist];
  if (i.s.prior) periods.push(i.s.prior);
  const rows: ChartRow[] = periods.map((p, ix) => ({
    key: `p${ix}`,
    label: p.periodLabel,
    value: p.incomeStatement.revenue,
    printed: i.money(p.incomeStatement.revenue),
    source: "70x",
    kind: ix === 0 ? "anchor" : "delta",
  }));
  // Deltas between consecutive periods, so the picture is the movement.
  const deltas: ChartRow[] = [];
  for (let x = 0; x < periods.length; x++) {
    if (x === 0) {
      deltas.push({ ...rows[0], kind: "anchor" });
    } else {
      const d = periods[x].incomeStatement.revenue - periods[x - 1].incomeStatement.revenue;
      deltas.push({ key: `d${x}`, label: `→ ${periods[x].periodLabel}`, value: d, printed: i.money(d), source: "70x movement", kind: "delta" });
    }
  }
  const dCur = i.s.incomeStatement.revenue - periods[periods.length - 1].incomeStatement.revenue;
  deltas.push({ key: "dcur", label: `→ ${i.s.periodLabel}`, value: dCur, printed: i.money(dCur), source: "70x movement", kind: "delta" });
  deltas.push({ key: "cur", label: i.s.periodLabel, value: i.s.incomeStatement.revenue, printed: i.money(i.s.incomeStatement.revenue), source: "70x", kind: "anchor" });
  return {
    id: "chart-revenue-trend",
    title,
    status: "drawn",
    svg: waterfall({ id: "chart-revenue-trend", title, unit: i.s.currency, rows: deltas }),
    rows: deltas,
    table: rowsTable(deltas, i.s.currency),
    caption: "Revenue movement between the periods this workspace holds.",
  };
}

/** Every block, in document order. */
export function allChartBlocks(i: ChartInputs): ChartBlock[] {
  return [
    ebitdaBridge(i),
    revenueMarginTrend(i),
    bsComposition(i),
    cashWalk(i),
    netDebtWalk(i),
    workingCapitalCycle(i),
    ratioBandTracks(i),
    creditContributions(i),
    covenantHeadroom(i),
    assetAge(i),
  ];
}
